import record from 'node-record-lpcm16';
import WebSocket, { WebSocketServer } from 'ws';
import http from 'http';
import { Buffer } from 'buffer';
import { config } from '@dotenvx/dotenvx';
import fs from 'fs';
import axios from 'axios';

// Charger les variables d'environnement
config();

// --- Configuration ---
const SAMPLE_RATE = 16000; // 16kHz (requis par Gladia)
const CHANNELS = 1; // Mono
const CHUNK_DURATION_MS = 100; // 100ms par chunk
const CHUNK_SIZE = (SAMPLE_RATE * CHANNELS * 2) * (CHUNK_DURATION_MS / 1000); // Taille en bytes (16 bits = 2 octets par échantillon)

// Nom du câble virtuel selon l'OS
const VIRTUAL_CABLE_NAME: Record<string, string> = {
  win32: "Cable Input (VB-Audio Virtual Cable)",
  darwin: "BlackHole 2ch",
  linux: "default",
};
const PLATFORM = process.platform;
const AUDIO_SOURCE = process.env.AUDIO_DEVICE || VIRTUAL_CABLE_NAME[PLATFORM] || VIRTUAL_CABLE_NAME.win32;

// Clé API Gladia
const GLADIA_API_KEY = process.env.GLADIA_API_KEY || "";

// Mode test : écrire dans un fichier WAV au lieu d'envoyer à Gladia
const TEST_MODE = process.env.TEST_MODE === 'true' || false;
const DEBUG = process.env.DEBUG === 'true' || false;
const OUTPUT_FILE = process.env.OUTPUT_FILE || 'output.wav';

// --- Types ---
type AudioChunk = Buffer;
type WavHeader = Buffer;

// --- Fonction pour créer un en-tête WAV minimal ---
function createWavHeader(dataSize: number): WavHeader {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * CHANNELS * 2, 28);
  header.writeUInt16LE(CHANNELS * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);
  return header;
}

// --- Fonction pour initialiser une session Gladia et obtenir l'URL WebSocket ---
async function initializeGladiaSession(): Promise<{ id: string; url: string }> {
  if (!GLADIA_API_KEY) {
    throw new Error("Clé API Gladia non définie");
  }

  try {
    const response = await axios.post(
      'https://api.gladia.io/v2/live',
      {
        encoding: 'wav/pcm',
        bit_depth: 16,
        sample_rate: 16000,
        channels: 1,
        custom_metadata: { user: 'OBS Gladia' },
        model: 'solaria-1',
        endpointing: 0.05,
        maximum_duration_without_endpointing: 5,
        language_config: { languages: ['fr'], code_switching: false },
        pre_processing: { audio_enhancer: false, speech_threshold: 0.6 },
        realtime_processing: {
          custom_vocabulary: false,
          custom_spelling: false,
          translation: false,
          named_entity_recognition: false,
          sentiment_analysis: false,
          translation_config: {
            model: 'base',
            match_original_utterances: true,
            lipsync: true,
            context_adaptation: true,
            informal: false
          }
        },
        post_processing: {
          summarization: false,
          summarization_config: { type: 'general' },
          chapterization: false
        },
        messages_config: {
          receive_partial_transcripts: true,
          receive_final_transcripts: true,
          receive_speech_events: true,
          receive_pre_processing_events: true,
          receive_realtime_processing_events: true,
          receive_post_processing_events: true,
          receive_acknowledgments: true,
          receive_errors: true,
          receive_lifecycle_events: false
        },
        callback: false
      },
      {
        headers: {
          'x-gladia-key': GLADIA_API_KEY,
          'Content-Type': 'application/json',
        },
      }
    );

    const { id, url } = response.data;
    console.log(`🔗 Session Gladia initialisée: ${id}`);
    console.log(`🔗 URL WebSocket: ${url}`);

    return { id, url };
  } catch (error) {
    console.error("❌ Erreur lors de l'initialisation de la session Gladia:", error);
    throw error;
  }
}

// --- Fonction pour récupérer le statut d'une session Gladia ---
async function getGladiaSessionStatus(sessionId: string): Promise<any> {
  if (!GLADIA_API_KEY) {
    throw new Error("Clé API Gladia non définie");
  }

  try {
    const response = await axios.get(
      `https://api.gladia.io/v2/live/${sessionId}`,
      {
        headers: {
          'x-gladia-key': GLADIA_API_KEY,
        },
      }
    );

    return response.data;
  } catch (error) {
    console.error("❌ Erreur lors de la récupération du statut Gladia:", error);
    throw error;
  }
}

// --- Fonction pour connecter le client WebSocket Gladia ---
async function connectToGladia(): Promise<{ ws: WebSocket; sessionId: string }> {
  try {
    const { id: sessionId, url: wsUrl } = await initializeGladiaSession();

    return new Promise((resolve, reject) => {
      const gladiaWs = new WebSocket(wsUrl);

      gladiaWs.on('open', () => {
        console.log('🔗 Connecté au WebSocket Gladia');
        resolve({ ws: gladiaWs, sessionId });
      });

      gladiaWs.on('error', (error) => {
        console.error('❌ Erreur WebSocket Gladia:', error);
        reject(error);
      });

      gladiaWs.on('close', () => {
        console.log('🔌 Déconnecté du WebSocket Gladia');
      });
    });
  } catch (error) {
    console.error('❌ Erreur lors de la connexion à Gladia:', error);
    throw error;
  }
}

// --- Script principal ---
async function main() {
  // Buffer pour stocker les chunks
  let audioBuffer: AudioChunk = Buffer.alloc(0);
  let rawAudioData: Buffer[] = []; // Pour stocker les données audio brutes en mode test

  // Créer un serveur HTTP pour servir l'interface et un serveur WebSocket pour relayer les chunks
  const indexHtmlPath = new URL('./index.html', import.meta.url);
  const server = http.createServer((req, res) => {
    if (req.url === '/' || req.url === '/index.html') {
      fs.readFile(indexHtmlPath, (err, data) => {
        if (err) {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Erreur interne');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(data);
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  });

  const wss = new WebSocketServer({ server });
  server.listen(8080, () => {
    console.log('🚀 Serveur HTTP + WebSocket démarré sur http://localhost:8080');
  });

  // Établir la connexion WebSocket avec Gladia (si pas en mode test)
  let gladiaWs: WebSocket | null = null;
  let gladiaSessionId: string | null = null;
  if (!TEST_MODE) {
    try {
      const { ws, sessionId } = await connectToGladia();
      gladiaWs = ws;
      gladiaSessionId = sessionId;
    } catch (error) {
      console.error('❌ Impossible de se connecter à Gladia:', error);
      process.exit(1);
    }
  }

  // Démarrer la capture audio (API correcte : record() puis .start())
  const recording = record.record({
    sampleRate: SAMPLE_RATE,
    channels: CHANNELS,
    threshold: 0,
    verbose: false,
    device: AUDIO_SOURCE,
  });

  // Gérer les messages de Gladia
  if (gladiaWs) {
    gladiaWs.on('message', (data: Buffer) => {
      try {
        const message = JSON.parse(data.toString());
        DEBUG && console.log('📨 Message Gladia:', message);

        const isTranscript =
          message.type === 'transcript' || message.event === 'transcript';

        if (!isTranscript) {
          return;
        }

        const text =
          message.transcription ||
          message.data?.utterance?.text ||
          message.data?.utterance?.text ||
          null;

        if (!text) {
          return;
        }

        console.log(`💬 Transcription: ${text}`);
        const payload = {
          text,
          type: message.event || message.type || 'transcript',
        };
        wss.clients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(payload));
          }
        });
      } catch (error) {
        console.error('❌ Erreur parsing message Gladia:', error);
      }
    });
  }

  // Récupérer le stream et gérer les données
  const audioStream = recording.stream();

  audioStream.on('data', (data: AudioChunk) => {
    audioBuffer = Buffer.concat([audioBuffer, data]);

    // Découper en chunks de 100ms
    while (audioBuffer.length >= CHUNK_SIZE) {
      const chunk = audioBuffer.slice(0, CHUNK_SIZE) as AudioChunk;
      audioBuffer = audioBuffer.slice(CHUNK_SIZE);

      // Mode test : stocker les données audio brutes
      if (TEST_MODE) {
        rawAudioData.push(chunk);
        return;
      }

      // Envoyer le chunk audio brut à Gladia via WebSocket
      if (gladiaWs && gladiaWs.readyState === WebSocket.OPEN) {
        gladiaWs.send(chunk);
      }
    }
  });

  // Gérer les connexions WebSocket
  wss.on('connection', (ws: WebSocket) => {
    console.log('🔌 Client WebSocket connecté !');
    ws.on('close', () => {
      console.log('🔴 Client WebSocket déconnecté.');
    });
  });

  // Gérer les erreurs
  audioStream.on('error', (err: Error) => {
    console.error('❌ Erreur de capture audio :', err);
  });

  // Arrêter proprement
  process.on('SIGINT', async () => {
    console.log('\n🛑 Arrêt de la capture audio...');

    // Écrire le fichier WAV en mode test
    if (TEST_MODE && rawAudioData.length > 0) {
      const fullAudioData = Buffer.concat(rawAudioData);
      const wavHeader = createWavHeader(fullAudioData.length);
      const fullWavData = Buffer.concat([wavHeader, fullAudioData]);
      fs.writeFileSync(OUTPUT_FILE, fullWavData);
      console.log(`💾 Fichier WAV enregistré : ${OUTPUT_FILE} (${fullAudioData.length} bytes)`);
    }

    // Récupérer le statut final de la session Gladia
    if (gladiaSessionId && !TEST_MODE) {
      try {
        console.log('📊 Récupération du statut final de la session Gladia...');
        const status = await getGladiaSessionStatus(gladiaSessionId);
        console.log('📊 Statut final:', status);
      } catch (error) {
        console.error('❌ Erreur lors de la récupération du statut final:', error);
      }
    }

    // Fermer la connexion WebSocket Gladia
    if (gladiaWs) {
      gladiaWs.close();
    }

    recording.stop();
    wss.close();
    server.close();
    process.exit();
  });

  console.log(`🎤 Capture audio démarrée depuis "${AUDIO_SOURCE}" (16kHz mono, chunks de ${CHUNK_DURATION_MS}ms).`);
}

// Lancer le script
main().catch((error) => {
  console.error('❌ Erreur fatale :', error);
  process.exit(1);
});