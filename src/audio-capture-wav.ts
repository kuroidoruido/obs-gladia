import record from 'node-record-lpcm16';
import WebSocket, { WebSocketServer } from 'ws';
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

// --- Fonction pour envoyer à Gladia via HTTP ---
async function sendToGladia(chunk: AudioChunk): Promise<string | null> {
  if (!GLADIA_API_KEY) {
    console.warn("⚠️  Clé API Gladia non définie. Ajoutez GLADIA_API_KEY dans votre fichier .env.");
    return null;
  }

  try {
    const response = await axios.post(
      'https://api.gladia.io/v2/transcription/',
      {
        audio: chunk.toString('base64'),
        language: 'fr',
        endpointing: 100,
      },
      {
        headers: {
          'x-gladia-key': GLADIA_API_KEY,
          'Content-Type': 'application/json',
        },
      }
    );

    return response.data?.transcription || null;
  } catch (error) {
    console.error("❌ Erreur Gladia :", error);
    return null;
  }
}

// --- Script principal ---
async function main() {
  // Buffer pour stocker les chunks
  let audioBuffer: AudioChunk = Buffer.alloc(0);
  let rawAudioData: Buffer[] = []; // Pour stocker les données audio brutes en mode test

  // Créer un serveur WebSocket pour relayer les chunks
  const wss = new WebSocketServer({ port: 8080 });
  console.log(`🚀 Serveur WebSocket démarré sur ws://localhost:8080`);

  // Démarrer la capture audio (API correcte : record() puis .start())
  const recording = record.record({
    sampleRate: SAMPLE_RATE,
    channels: CHANNELS,
    threshold: 0,
    verbose: false,
    device: AUDIO_SOURCE,
  });

  // Démarrer explicitement la capture
  recording.start();

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

      // Créer un chunk WAV
      const wavHeader = createWavHeader(chunk.length);
      const wavChunk = Buffer.concat([wavHeader, chunk]);

      // Envoyer le chunk WAV aux clients WebSocket
      wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(wavChunk);
        }
      });

      // Envoyer à Gladia et relayer la transcription
      sendToGladia(chunk).then((transcription) => {
        if (transcription) {
          console.log(`💬 Transcription: ${transcription}`);
          wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify({ text: transcription }));
            }
          });
        }
      });
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
  process.on('SIGINT', () => {
    console.log('\n🛑 Arrêt de la capture audio...');

    // Écrire le fichier WAV en mode test
    if (TEST_MODE && rawAudioData.length > 0) {
      const fullAudioData = Buffer.concat(rawAudioData);
      const wavHeader = createWavHeader(fullAudioData.length);
      const fullWavData = Buffer.concat([wavHeader, fullAudioData]);
      fs.writeFileSync(OUTPUT_FILE, fullWavData);
      console.log(`💾 Fichier WAV enregistré : ${OUTPUT_FILE} (${fullAudioData.length} bytes)`);
    }

    recording.stop();
    wss.close();
    process.exit();
  });

  console.log(`🎤 Capture audio démarrée depuis "${AUDIO_SOURCE}" (16kHz mono, chunks de ${CHUNK_DURATION_MS}ms).`);
}

// Lancer le script
main().catch((error) => {
  console.error('❌ Erreur fatale :', error);
  process.exit(1);
});