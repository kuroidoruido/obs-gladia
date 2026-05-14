import { exec } from 'child_process';
import { promisify } from 'util';
import { platform } from 'os';

const execAsync = promisify(exec);

// Fonction pour lister les périphériques audio selon l'OS
async function listAudioDevices(): Promise<string[]> {
  const os = platform();

  try {
    if (os === 'win32') {
      // Windows : Utiliser ffmpeg pour lister les périphériques dshow
      const { stdout } = await execAsync('ffmpeg -list_devices true -f dshow -i dummy');
      const devices: string[] = [];
      const lines = stdout.split('\n');
      let captureDevices = false;

      for (const line of lines) {
        if (line.includes('[dshow @')) {
          captureDevices = line.includes('DirectShow audio devices');
        } else if (captureDevices && line.trim().startsWith('"')) {
          const deviceName = line.trim().replace(/["\[]/g, '');
          devices.push(deviceName);
        }
      }
      return devices;
    } else if (os === 'darwin') {
      // macOS : Utiliser ffmpeg pour lister les périphériques avfoundation
      const { stdout } = await execAsync('ffmpeg -f avfoundation -list_devices true -i ""');
      const devices: string[] = [];
      const lines = stdout.split('\n');
      let captureDevices = false;

      for (const line of lines) {
        if (line.includes('[AVFoundation input device @')) {
          captureDevices = true;
        } else if (captureDevices && line.includes('AVFoundation audio')) {
          const deviceName = line.split('] ')[1].trim();
          devices.push(deviceName);
        }
      }
      return devices;
    } else if (os === 'linux') {
      // Linux : Utiliser pactl pour lister les sources audio
      const { stdout } = await execAsync('pactl list short sources');
      const devices: string[] = stdout
        .split('\n')
        .filter(line => line.trim() !== '')
        .map(line => {
          const parts = line.split('\t');
          return parts[1] || parts[0]; // Retourne le nom du périphérique
        });
      return devices;
    } else {
      throw new Error(`OS non supporté : ${os}`);
    }
  } catch (error) {
    console.error('❌ Erreur lors de la liste des périphériques audio :', error);
    return [];
  }
}

// Fonction principale
async function main() {
  console.log('🔍 Recherche des périphériques audio disponibles...\n');

  const devices = await listAudioDevices();
  const os = platform();

  if (devices.length === 0) {
    console.log('⚠️  Aucun périphérique audio trouvé.');
    return;
  }

  console.log(`📋 Périphériques audio disponibles (${os}):\n`);
  devices.forEach((device, index) => {
    console.log(`${index + 1}. ${device}`);
  });

  // Suggestions pour les câbles virtuels courants
  console.log('\n💡 Suggestions pour les câbles virtuels :');
  if (os === 'win32') {
    console.log('- VB-Cable : "Cable Input (VB-Audio Virtual Cable)"');
  } else if (os === 'darwin') {
    console.log('- BlackHole : "BlackHole 2ch" ou "BlackHole 16ch"');
  } else if (os === 'linux') {
    console.log('- PulseAudio Null Sink : "default" ou un nom personnalisé (ex: "null_sink")');
  }

  console.log('\n📌 Utilisez le nom exact d\'un périphérique ci-dessus pour configurer VIRTUAL_CABLE_NAME.');
}

main().catch((error) => {
  console.error('❌ Erreur fatale :', error);
  process.exit(1);
});