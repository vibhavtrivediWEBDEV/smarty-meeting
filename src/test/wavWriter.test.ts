import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WavWriter } from '../audio/wavWriter';

test('PCM16 WAV has accurate duration, sample rate and playable header', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meetingassistant-wav-'));
  try {
    const output = path.join(directory, 'microphone.wav');
    const writer = new WavWriter(output, 48_000);
    const samples = Buffer.alloc(48_000 * 2);
    for (let sample = 0; sample < 48_000; sample += 1) {
      samples.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * sample / 48_000) * 10_000), sample * 2);
    }
    writer.write(samples);
    assert.equal(writer.durationMs, 1000);
    writer.close();
    const saved = fs.readFileSync(output);
    assert.equal(saved.toString('ascii', 0, 4), 'RIFF');
    assert.equal(saved.toString('ascii', 8, 12), 'WAVE');
    assert.equal(saved.readUInt32LE(4), saved.length - 8);
    assert.equal(saved.readUInt16LE(20), 1);
    assert.equal(saved.readUInt16LE(22), 1);
    assert.equal(saved.readUInt32LE(24), 48_000);
    assert.equal(saved.readUInt16LE(34), 16);
    assert.equal(saved.readUInt32LE(40), 96_000);
    assert.equal(saved.readInt16LE(44 + 2 * 12), samples.readInt16LE(2 * 12));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});