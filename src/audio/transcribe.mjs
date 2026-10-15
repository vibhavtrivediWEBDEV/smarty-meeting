import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline, env } from '@huggingface/transformers';
import { NonRealTimeVAD } from '@ricky0123/vad-node';

console.debug = console.error;
const [inputPath, cacheDirectory, source = 'microphone'] = process.argv.slice(2);
if (!inputPath || !cacheDirectory) throw new Error('Audio path and model cache are required');
if (source !== 'microphone' && source !== 'system') throw new Error('Unknown audio source');
const sourceName = source === 'system' ? 'System playback' : 'Microphone';

function readMonoPcm16(filePath) {
  const wav = fs.readFileSync(filePath);
  if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Expected a WAV recording');
  }
  let format;
  let samples;
  for (let offset = 12; offset + 8 <= wav.length;) {
    const size = wav.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + size > wav.length) throw new Error('Invalid WAV chunk');
    if (wav.toString('ascii', offset, offset + 4) === 'fmt ') {
      format = { codec: wav.readUInt16LE(start), channels: wav.readUInt16LE(start + 2),
        rate: wav.readUInt32LE(start + 4), bits: wav.readUInt16LE(start + 14) };
    }
    if (wav.toString('ascii', offset, offset + 4) === 'data') {
      samples = wav.subarray(start, start + size);
    }
    offset = start + size + (size % 2);
  }
  if (!format || format.codec !== 1 || format.channels !== 1 || format.rate !== 16000 ||
      format.bits !== 16 || !samples || samples.length % 2 !== 0) {
    throw new Error('Expected mono 16 kHz PCM16 audio');
  }
  const audio = new Float32Array(samples.length / 2);
  for (let index = 0; index < audio.length; index += 1) {
    audio[index] = samples.readInt16LE(index * 2) / 32768;
  }
  return audio;
}

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'meetingassistant-asr-'));
try {
  const convertedPath = path.join(temporaryDirectory, 'speech.wav');
  execFileSync('/usr/bin/afconvert', [inputPath, '-o', convertedPath, '-f', 'WAVE',
    '-d', 'LEI16@16000', '-c', '1']);
  const audio = readMonoPcm16(convertedPath);
  const rms = Math.sqrt(audio.reduce((sum, value) => sum + value * value, 0) / audio.length);
  if (rms < 0.005) {
    process.stdout.write(JSON.stringify({ text: '', segments: [],
      warning: source === 'system' ? 'System playback is very quiet. Check the saved recording.' :
        'Microphone audio is very quiet. Select a working microphone and record again.' }));
  } else {
    const detector = await NonRealTimeVAD.new();
    const speechActivity = [];
    for await (const region of detector.run(audio, 16000)) {
      speechActivity.push({ start: region.start / 1000, end: region.end / 1000 });
    }
    if (!speechActivity.length) {
      process.stdout.write(JSON.stringify({ text: '', segments: [], speechActivity,
        warning: `No likely speech activity detected in ${sourceName.toLowerCase()} audio. Check the saved recording.` }));
    } else {
      env.cacheDir = cacheDirectory;
      const transcriber = await pipeline('automatic-speech-recognition', 'Xenova/whisper-base');
      const result = await transcriber(audio, { return_timestamps: true, chunk_length_s: 30 });
      const segments = (result.chunks ?? []).map(chunk => ({
        start: Number(chunk.timestamp[0] ?? 0),
        end: Number(chunk.timestamp[1] ?? chunk.timestamp[0] ?? 0),
        text: chunk.text.trim(),
        source
      })).filter(segment => segment.text);
      if (!segments.length && result.text?.trim()) {
        segments.push({ start: 0, end: audio.length / 16000,
          text: result.text.trim(), source });
      }
      process.stdout.write(JSON.stringify({ text: result.text?.trim() ?? '', segments, speechActivity }));
    }
  }
} finally {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}