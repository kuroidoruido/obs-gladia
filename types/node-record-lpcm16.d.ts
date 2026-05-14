// Type definitions for node-record-lpcm16
// Project: node-record-lpcm16

declare module 'node-record-lpcm16' {
  import { ChildProcess, SpawnOptions } from 'child_process';
  import { Readable } from 'stream';

  interface RecordingOptions {
    sampleRate?: number;       // Fréquence d'échantillonnage (default: 16000)
    channels?: number;        // Nombre de canaux (default: 1)
    compress?: boolean;       // Compression (default: false)
    threshold?: number;       // Seuil de détection de son (default: 0.5)
    thresholdStart?: number | null; // Seuil pour démarrer l'enregistrement
    thresholdEnd?: number | null;   // Seuil pour arrêter l'enregistrement
    silence?: string;         // Durée de silence pour arrêter (default: "1.0")
    recorder?: string;        // Recorder à utiliser (default: "sox")
    endOnSilence?: boolean;   // Arrêter sur silence (default: false)
    audioType?: string;       // Type audio (default: "wav")
    device?: string;          // Périphérique audio à utiliser
    verbose?: boolean;        // Mode verbeux
  }

  interface RecordingProcess {
    cmd: string;
    args: string[];
    cmdOptions: SpawnOptions;
    process: ChildProcess;
    _stream: Readable;
  }

  class Recording {
    constructor(options?: RecordingOptions);

    options: RecordingOptions & {
      sampleRate: number;
      channels: number;
      compress: boolean;
      threshold: number;
      thresholdStart: number | null;
      thresholdEnd: number | null;
      silence: string;
      recorder: string;
      endOnSilence: boolean;
      audioType: string;
    };

    cmd: string;
    args: string[];
    cmdOptions: SpawnOptions;
    process: ChildProcess;
    _stream: Readable;

    start(): this;
    stop(): void;
    pause(): void;
    resume(): void;
    isPaused(): boolean;
    stream(): Readable;

    on(event: 'data', listener: (chunk: Buffer) => void): this;
    on(event: 'end', listener: () => void): this;
    on(event: 'error', listener: (error: Error) => void): this;
  }

  interface NodeRecordLPCM16 {
    record: (options?: RecordingOptions) => Recording;
  }

  const nodeRecordLPCM16: NodeRecordLPCM16;
  export = nodeRecordLPCM16;
}