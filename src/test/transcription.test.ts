import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { NonRealTimeVAD } from '@ricky0123/vad-node';
import { WavWriter } from '../audio/wavWriter';

test('very quiet audio is not turned into invented speech', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meetingassistant-test-'));
  try {
    const wavPath = path.join(directory, 'microphone.wav');
    const writer = new WavWriter(wavPath, 44100);
    writer.write(Buffer.alloc(44100 * 2));
    writer.close();
    const worker = path.join(__dirname, '..', '..', 'src', 'audio', 'transcribe.mjs');
    const result = JSON.parse(execFileSync(process.execPath,
      [worker, wavPath, path.join(directory, 'models')], { encoding: 'utf8' }));
    assert.equal(result.text, '');
    assert.deepEqual(result.segments, []);
    assert.match(result.warning, /very quiet/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('silent system playback is not reported as microphone speech', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meetingassistant-test-'));
  try {
    const wavPath = path.join(directory, 'system.wav');
    const writer = new WavWriter(wavPath, 16000);
    writer.write(Buffer.alloc(16000 * 2));
    writer.close();
    const worker = path.join(__dirname, '..', '..', 'src', 'audio', 'transcribe.mjs');
    const result = JSON.parse(execFileSync(process.execPath,
      [worker, wavPath, path.join(directory, 'models'), 'system'], { encoding: 'utf8' }));
    assert.deepEqual(result.segments, []);
    assert.match(result.warning, /System playback is very quiet/);
    assert.doesNotMatch(result.warning, /Microphone/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('VAD can reject a clean tone but cannot identify speakers', async () => {
  const samples = new Float32Array(32000);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = Math.sin(2 * Math.PI * 440 * index / 16000) * 0.3;
  }
  const detector = await NonRealTimeVAD.new();
  const regions = [];
  for await (const region of detector.run(samples, 16000)) regions.push(region);
  assert.equal(regions.length, 0);
});