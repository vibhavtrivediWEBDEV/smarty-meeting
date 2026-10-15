import fs from 'node:fs';

export class WavWriter {
  private readonly descriptor: number;
  private bytesWritten = 0;
  private closed = false;

  constructor(readonly filePath: string, readonly sampleRate: number, readonly channels = 1) {
    if (!Number.isInteger(sampleRate) || sampleRate < 8_000 || sampleRate > 192_000 || channels !== 1) {
      throw new Error('Unsupported PCM format');
    }
    this.descriptor = fs.openSync(filePath, 'wx', 0o600);
    this.writeHeader();
  }

  write(chunk: Buffer): void {
    if (this.closed) throw new Error('Recording has stopped');
    if (!Buffer.isBuffer(chunk) || chunk.length === 0 || chunk.length % 2 !== 0 ||
      this.bytesWritten + chunk.length > 0xffffffff - 36) {
      throw new Error('Invalid PCM audio chunk');
    }
    fs.writeSync(this.descriptor, chunk, 0, chunk.length, 44 + this.bytesWritten);
    this.bytesWritten += chunk.length;
    this.writeHeader();
  }

  get durationMs(): number {
    return Math.round(this.bytesWritten / (this.sampleRate * this.channels * 2) * 1000);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.writeHeader();
      fs.fsyncSync(this.descriptor);
    } finally {
      fs.closeSync(this.descriptor);
    }
  }

  private writeHeader(): void {
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + this.bytesWritten, 4);
    header.write('WAVEfmt ', 8);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(this.channels, 22);
    header.writeUInt32LE(this.sampleRate, 24);
    header.writeUInt32LE(this.sampleRate * this.channels * 2, 28);
    header.writeUInt16LE(this.channels * 2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(this.bytesWritten, 40);
    fs.writeSync(this.descriptor, header, 0, header.length, 0);
  }
}