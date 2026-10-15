import { app, BrowserWindow, ipcMain, session, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { WavWriter } from './audio/wavWriter';

let window: BrowserWindow | null = null;
let recording: { writer: WavWriter; systemWriter?: WavWriter; systemProcess?: ChildProcessWithoutNullStreams;
  directory: string; startedAt: string; inputDevice: string } | null = null;
const pagePath = path.join(__dirname, '..', 'src', 'renderer', 'index.html');
const meetingsRoot = () => path.join(app.getPath('documents'), 'Meeting Assistant', 'meetings');
const legacyMeetingsRoot = () => path.join(app.getPath('userData'), 'meetings');

function findMeetingDirectory(id: string): string | undefined {
  if (!/^[\w-]{20,100}$/.test(id)) return undefined;
  return [meetingsRoot(), legacyMeetingsRoot()]
    .map(root => path.join(root, id))
    .find(directory => fs.existsSync(path.join(directory, 'meeting.json')) &&
      fs.existsSync(path.join(directory, 'microphone.wav')));
}

function completedMeetingDirectory(id: unknown): string {
  if (typeof id !== 'string' || !listMeetings().some(meeting => meeting.id === id)) {
    throw new Error('Unknown completed meeting');
  }
  const directory = findMeetingDirectory(id);
  if (!directory) throw new Error('Meeting folder is missing');
  return directory;
}

function isAppPage(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): boolean {
  return Boolean(window && event.sender === window.webContents &&
    event.senderFrame === window.webContents.mainFrame &&
    event.senderFrame.url === pathToFileURL(pagePath).href);
}

function writeMetadata(directory: string, metadata: object): void {
  const target = path.join(directory, 'meeting.json');
  const temporary = `${target}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(metadata, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, target);
}

type Transcript = { text: string; inputDevice?: string; speechActivity?: Array<{
  start: number; end: number
}>; speechActivityBySource?: { microphone: Array<{ start: number; end: number }>;
  system?: Array<{ start: number; end: number }>
}; segments: Array<{
  start: number; end: number; text: string; source: 'microphone' | 'system'
}>; warning?: string };

function transcribe(directory: string, source: 'microphone' | 'system'): Promise<Transcript> {
  return new Promise((resolve, reject) => {
    const worker = path.join(__dirname, '..', 'src', 'audio', 'transcribe.mjs');
    const child = spawn(process.execPath, [worker, path.join(directory, `${source}.wav`),
      path.join(app.getPath('userData'), 'models'), source], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    let errors = '';
    const timeout = setTimeout(() => child.kill(), 60 * 60 * 1000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      output += chunk;
      if (output.length > 16_000_000) child.kill();
    });
    child.stderr.on('data', (chunk: string) => { errors = (errors + chunk).slice(-1000); });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('close', code => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(errors.trim() || 'Local transcription process failed'));
        return;
      }
      try {
        const transcript = JSON.parse(output) as Transcript;
        if (typeof transcript.text !== 'string' || !Array.isArray(transcript.segments)) {
          throw new Error('Invalid transcript response');
        }
        transcript.segments = transcript.segments.map(segment => ({ ...segment, source }));
        resolve(transcript);
      } catch (error) { reject(error); }
    });
  });
}

function writeTranscriptText(directory: string, transcript: Transcript): void {
  const mergedPath = path.join(directory, 'transcript.txt');
  if (!fs.existsSync(mergedPath)) {
    fs.writeFileSync(mergedPath,
      transcript.segments.map(segment =>
        `[${Math.floor(segment.start / 60).toString().padStart(2, '0')}:${
          Math.floor(segment.start % 60).toString().padStart(2, '0')}] ${segment.source === 'system' ? 'Mixed system playback (app, site and speaker unknown)' : 'Mixed mic audio (speaker unknown)'}: ${segment.text}`
      ).join('\n') + '\n', { mode: 0o600 });
  }
  for (const source of ['microphone', 'system'] as const) {
    if (source === 'system' && !fs.existsSync(path.join(directory, 'system.wav'))) continue;
    if (source === 'system' && transcript.warning?.includes('System audio transcription failed')) continue;
    const sourcePath = path.join(directory, `transcript-${source}.txt`);
    if (fs.existsSync(sourcePath)) continue;
    fs.writeFileSync(sourcePath,
      transcript.segments.filter(segment => segment.source === source).map(segment =>
        `[${Math.floor(segment.start / 60).toString().padStart(2, '0')}:${
          Math.floor(segment.start % 60).toString().padStart(2, '0')}] Speaker unknown: ${segment.text}`
      ).join('\n') + '\n', { mode: 0o600 });
  }
}

async function loadTranscript(directory: string): Promise<Transcript> {
  const target = path.join(directory, 'transcript.json');
  if (fs.existsSync(target)) {
    const saved = JSON.parse(fs.readFileSync(target, 'utf8')) as Transcript;
    if (!fs.existsSync(path.join(directory, 'transcript.txt')) ||
      !fs.existsSync(path.join(directory, 'transcript-microphone.txt')) ||
      fs.existsSync(path.join(directory, 'system.wav')) && !fs.existsSync(path.join(directory, 'transcript-system.txt'))) {
      writeTranscriptText(directory, saved);
    }
    return saved;
  }
  const transcript = await transcribe(directory, 'microphone');
  transcript.speechActivityBySource = { microphone: transcript.speechActivity ?? [] };
  fs.writeFileSync(path.join(directory, 'transcript-microphone.json'), JSON.stringify(transcript, null, 2), { mode: 0o600 });
  if (fs.existsSync(path.join(directory, 'system.wav')) && fs.statSync(path.join(directory, 'system.wav')).size > 44) {
    try {
      const systemTranscript = await transcribe(directory, 'system');
      transcript.speechActivityBySource.system = systemTranscript.speechActivity ?? [];
      fs.writeFileSync(path.join(directory, 'transcript-system.json'), JSON.stringify(systemTranscript, null, 2), { mode: 0o600 });
      transcript.segments.push(...systemTranscript.segments);
      transcript.segments.sort((left, right) => left.start - right.start);
      transcript.text = transcript.segments.map(segment => segment.text).join(' ');
    } catch (error) {
      transcript.warning = `System audio transcription failed; only microphone text was saved: ${String(error)}`;
    }
  }
  const metadata = JSON.parse(fs.readFileSync(path.join(directory, 'meeting.json'), 'utf8')) as {
    inputDevice?: string
  };
  if (metadata.inputDevice) transcript.inputDevice = metadata.inputDevice;
  fs.writeFileSync(target, JSON.stringify(transcript, null, 2), { mode: 0o600 });
  writeTranscriptText(directory, transcript);
  return transcript;
}

function startSystemAudio(writer: WavWriter): Promise<ChildProcessWithoutNullStreams> {
  return new Promise((resolve, reject) => {
    const child = spawn(path.join(__dirname, 'systemAudio'), [], { stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.end();
    let ready = false;
    let errors = '';
    let remainder = Buffer.alloc(0);
    const timeout = setTimeout(() => child.kill(), 30_000);
    child.stdout.on('data', (chunk: Buffer) => {
      const data = Buffer.concat([remainder, chunk]);
      const size = data.length - data.length % 2;
      if (size) writer.write(data.subarray(0, size));
      remainder = data.subarray(size);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      errors = (errors + chunk.toString()).slice(-2000);
      if (!ready && errors.includes('READY\n')) {
        ready = true;
        clearTimeout(timeout);
        resolve(child);
      }
    });
    child.once('error', error => { clearTimeout(timeout); if (!ready) reject(error); });
    child.once('close', code => {
      clearTimeout(timeout);
      if (!ready) reject(new Error(errors.trim() || `System audio capture exited (${code})`));
    });
  });
}

async function stopRecording(): Promise<{ directory: string; durationMs: number; systemAudio: boolean }> {
  if (!recording) throw new Error('No recording is active');
  const current = recording;
  recording = null;
  if (current.systemProcess && current.systemProcess.exitCode === null) {
    const process = current.systemProcess;
    const ended = new Promise<void>(resolve => process.once('close', () => resolve()));
    process.kill('SIGTERM');
    let forceStop: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([ended, new Promise<void>(resolve => {
      forceStop = setTimeout(() => { process.kill('SIGKILL'); resolve(); }, 2000);
    })]);
    if (forceStop) clearTimeout(forceStop);
  }
  current.writer.close();
  current.systemWriter?.close();
  writeMetadata(current.directory, {
    state: 'recorded', startedAt: current.startedAt,
    stoppedAt: new Date().toISOString(), durationMs: current.writer.durationMs,
    sampleRate: current.writer.sampleRate, channels: 1,
    sources: current.systemWriter ? ['microphone', 'system'] : ['microphone'],
    inputDevice: current.inputDevice
  });
  return { directory: current.directory, durationMs: current.writer.durationMs,
    systemAudio: Boolean(current.systemWriter?.durationMs) };
}

function listMeetings(): Array<{ id: string; startedAt: string; durationMs: number; inputDevice: string }> {
  return [meetingsRoot(), legacyMeetingsRoot()].flatMap(meetings =>
    fs.existsSync(meetings) ? fs.readdirSync(meetings, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => {
      const metadataPath = path.join(meetings, entry.name, 'meeting.json');
      if (!fs.existsSync(metadataPath) || !fs.existsSync(path.join(meetings, entry.name, 'microphone.wav'))) return null;
      try {
        const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8')) as {
          state: string; startedAt: string; durationMs: number; inputDevice?: string
        };
        if (metadata.state !== 'recorded' || !Number.isFinite(metadata.durationMs)) return null;
        return { id: entry.name, startedAt: metadata.startedAt, durationMs: metadata.durationMs,
          inputDevice: metadata.inputDevice || 'Microphone (device not recorded)' };
      } catch { return null; }
    }).filter((entry): entry is NonNullable<typeof entry> => entry !== null) : [])
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const trusted = window?.webContents === webContents &&
      webContents.getURL() === pathToFileURL(pagePath).href;
    callback(Boolean(trusted && permission === 'media' &&
      'mediaTypes' in details && details.mediaTypes?.length === 1 &&
      details.mediaTypes[0] === 'audio'));
  });

  ipcMain.handle('app:ping', event => {
    if (!isAppPage(event)) throw new Error('Untrusted page');
    return 'ready';
  });

  ipcMain.handle('meeting:list', event => {
    if (!isAppPage(event)) throw new Error('Untrusted page');
    return listMeetings();
  });

  ipcMain.handle('meeting:reveal', (event, id: unknown) => {
    if (!isAppPage(event)) throw new Error('Untrusted page');
    if (id === null) {
      fs.mkdirSync(meetingsRoot(), { recursive: true, mode: 0o700 });
      shell.showItemInFolder(meetingsRoot());
      return;
    }
    shell.showItemInFolder(completedMeetingDirectory(id));
  });

  ipcMain.handle('meeting:delete', (event, id: unknown) => {
    if (!isAppPage(event)) throw new Error('Untrusted page');
    const directory = completedMeetingDirectory(id);
    if (recording?.directory === directory) throw new Error('Cannot delete an active recording');
    fs.rmSync(directory, { recursive: true });
  });

  ipcMain.handle('meeting:analyze', async (event, id: unknown) => {
    if (!isAppPage(event)) throw new Error('Untrusted page');
    const directory = completedMeetingDirectory(id);
    const transcriptPath = path.join(directory, 'transcript.txt');
    const savedTranscript = await loadTranscript(directory);
    if (savedTranscript.warning?.includes('System audio transcription failed')) {
      throw new Error('System track transcription failed; AI analysis requires a complete transcript');
    }
    const transcript = fs.readFileSync(transcriptPath, 'utf8').trim();
    if (!transcript) throw new Error('No speech transcript is available for AI analysis');
    if (transcript.length > 100_000) throw new Error('Transcript is too long for one AI request; no text was sent');
    const apiKey = process.env.BEDROCK_MANTLE_API_KEY || process.env.AWS_BEARER_TOKEN_BEDROCK;
    const endpoint = process.env.BEDROCK_MANTLE_ENDPOINT || process.env.BEDROCK_MANTLE_BASE_URL;
    if (!apiKey || !endpoint) throw new Error('Set BEDROCK_MANTLE_API_KEY and BEDROCK_MANTLE_ENDPOINT before starting the app');
    const url = new URL(`${endpoint.replace(/\/$/, '')}/chat/completions`);
    if (url.protocol !== 'https:') throw new Error('AI endpoint must use HTTPS');
    const model = process.env.BEDROCK_MODEL || 'zai.glm-5';
    const response = await fetch(url, {
      method: 'POST', signal: AbortSignal.timeout(120_000),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages: [
        { role: 'system', content: 'Summarize this meeting transcript with key decisions, action items and unresolved questions. Keep speaker identities unknown. Capture-source labels are not speaker identities. Do not invent missing details.' },
        { role: 'user', content: transcript }
      ] })
    });
    if (!response.ok) throw new Error(`AI request failed (${response.status})`);
    const result = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const notes = result.choices?.[0]?.message?.content;
    if (!notes) throw new Error('AI returned no notes');
    fs.writeFileSync(path.join(directory, 'ai-notes.txt'), notes, { mode: 0o600 });
    return notes;
  });

  ipcMain.handle('meeting:open', async (event, id: unknown) => {
    if (!isAppPage(event)) throw new Error('Untrusted page');
    const directory = completedMeetingDirectory(id);
    return { directory, audioUrl: pathToFileURL(path.join(directory, 'microphone.wav')).href,
      systemAudioUrl: fs.existsSync(path.join(directory, 'system.wav')) && fs.statSync(path.join(directory, 'system.wav')).size > 44
        ? pathToFileURL(path.join(directory, 'system.wav')).href : undefined,
      transcript: await loadTranscript(directory),
      aiNotes: fs.existsSync(path.join(directory, 'ai-notes.txt')) ? fs.readFileSync(path.join(directory, 'ai-notes.txt'), 'utf8') : undefined };
  });

  ipcMain.handle('meeting:latest', async event => {
    if (!isAppPage(event)) throw new Error('Untrusted page');
    const latest = listMeetings()[0]?.id;
    if (!latest) return null;
    const directory = findMeetingDirectory(latest);
    if (!directory) throw new Error('Meeting folder is missing');
    return { directory, audioUrl: pathToFileURL(path.join(directory, 'microphone.wav')).href,
      systemAudioUrl: fs.existsSync(path.join(directory, 'system.wav')) && fs.statSync(path.join(directory, 'system.wav')).size > 44
        ? pathToFileURL(path.join(directory, 'system.wav')).href : undefined,
      transcript: await loadTranscript(directory) };
  });

  ipcMain.handle('recording:start', async (event, request: unknown) => {
    if (!isAppPage(event)) throw new Error('Untrusted page');
    if (recording) throw new Error('A recording is already active');
    if (!request || typeof request !== 'object' || !('consentConfirmed' in request) ||
      request.consentConfirmed !== true || !('sampleRate' in request) ||
      typeof request.sampleRate !== 'number' || !Number.isInteger(request.sampleRate) ||
      request.sampleRate < 8_000 || request.sampleRate > 192_000 ||
      !('deviceLabel' in request) || typeof request.deviceLabel !== 'string' ||
      request.deviceLabel.length > 200 || !('captureSystem' in request) ||
      typeof request.captureSystem !== 'boolean') {
      throw new Error('Consent and a valid microphone sample rate are required');
    }
    const startedAt = new Date().toISOString();
    const directory = path.join(meetingsRoot(),
      `${startedAt.replace(/[:.]/g, '-')}-${randomUUID()}`);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const writer = new WavWriter(path.join(directory, 'microphone.wav'), request.sampleRate);
    let systemWriter: WavWriter | undefined;
    let systemProcess: ChildProcessWithoutNullStreams | undefined;
    try {
      if (request.captureSystem) {
        systemWriter = new WavWriter(path.join(directory, 'system.wav'), 16000);
        systemProcess = await startSystemAudio(systemWriter);
      }
    } catch (error) {
      writer.close();
      systemWriter?.close();
      fs.rmSync(directory, { recursive: true, force: true });
      throw error;
    }
    recording = { writer, systemWriter, systemProcess, directory, startedAt, inputDevice: request.deviceLabel };
    writeMetadata(directory, { state: 'recording', startedAt, sampleRate: writer.sampleRate,
      channels: 1, sources: request.captureSystem ? ['microphone', 'system'] : ['microphone'],
      inputDevice: request.deviceLabel });
    return { directory };
  });

  ipcMain.handle('recording:chunk', (event, chunk: unknown) => {
    if (!isAppPage(event)) throw new Error('Untrusted page');
    if (!recording) throw new Error('No recording is active');
    if (!(chunk instanceof Uint8Array) || chunk.byteLength > 131_072) {
      throw new Error('Invalid microphone audio chunk');
    }
    recording.writer.write(Buffer.from(chunk));
  });

  ipcMain.handle('recording:stop', async event => {
    if (!isAppPage(event)) throw new Error('Untrusted page');
    const result = await stopRecording();
    try {
      return { ...result, audioUrl: pathToFileURL(path.join(result.directory, 'microphone.wav')).href,
        systemAudioUrl: result.systemAudio ? pathToFileURL(path.join(result.directory, 'system.wav')).href : undefined,
        transcript: await loadTranscript(result.directory) };
    } catch (error) {
      return { ...result, audioUrl: pathToFileURL(path.join(result.directory, 'microphone.wav')).href,
        systemAudioUrl: result.systemAudio ? pathToFileURL(path.join(result.directory, 'system.wav')).href : undefined,
        transcriptionError: String(error) };
    }
  });

  window = new BrowserWindow({
    width: 980,
    height: 680,
    minWidth: 680,
    minHeight: 520,
    backgroundColor: '#f5f5f2',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  });
  window.loadFile(pagePath);
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== pathToFileURL(pagePath).href) event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.on('closed', () => {
    if (recording) void stopRecording();
    window = null;
  });
  if (process.env.MEETING_ASSISTANT_SMOKE === '1') {
    window.webContents.on('console-message', (_event, level, message) => {
      console.info(`Renderer console ${level}: ${message}`);
    });
    window.webContents.on('did-fail-load', (_event, code, description) => {
      console.error(`Renderer load failed ${code}: ${description}`);
    });
    window.webContents.once('did-finish-load', async () => {
      try {
        const result = await window?.webContents.executeJavaScript(`new Promise((resolve, reject) => {
          const status = document.querySelector('#status');
          const check = () => {
            if (status.textContent === 'Ready to record') {
              resolve({ status: status.textContent, api: typeof window.meetingAPI,
                node: typeof require, startDisabled: document.querySelector('#start').disabled });
              return true;
            }
            return false;
          };
          if (!check()) {
            const observer = new MutationObserver(() => { if (check()) observer.disconnect(); });
            observer.observe(status, { childList: true });
            setTimeout(() => { observer.disconnect(); reject(new Error(status.textContent)); }, 5000);
          }
        })`);
        if (!result || result.status !== 'Ready to record' || result.node !== 'undefined' ||
          result.api !== 'object' || !result.startDisabled) throw new Error('Renderer boundary check failed');
        console.info('Electron UI/IPC smoke passed:', result);
        if (process.env.MEETING_ASSISTANT_LATEST_SMOKE === '1') {
          const latest = await window?.webContents.executeJavaScript(`new Promise((resolve, reject) => {
            const player = document.querySelector('#playback');
            const transcript = document.querySelector('#transcript-status');
            const check = () => {
              if (player.readyState >= 1 && player.src) {
                resolve({ duration: player.duration, transcriptStatus: transcript.textContent,
                  playerVisible: !player.hidden });
              }
            };
            player.addEventListener('loadedmetadata', check);
            player.addEventListener('error', () => reject(new Error('Audio player failed to load')));
            const observer = new MutationObserver(check);
            observer.observe(player, { attributes: true });
            check();
            setTimeout(() => reject(new Error(transcript.textContent)), 30000);
          })`);
          if (!latest || !latest.playerVisible || latest.duration <= 0) {
            throw new Error('Latest meeting did not load into the audio player');
          }
          console.info('Latest meeting UI smoke passed:', latest);
          const sourceViews = await window?.webContents.executeJavaScript(`(async () => {
            const meeting = await window.meetingAPI.latest();
            const views = document.querySelector('#transcript-views');
            const buttons = Object.fromEntries(Array.from(views.querySelectorAll('button[data-source]'))
              .map(button => [button.dataset.source, button]));
            const lineCount = () => document.querySelectorAll('#transcript-lines .transcript-row').length;
            buttons.microphone.click();
            const microphone = lineCount();
            if (microphone !== meeting.transcript.segments.filter(segment => segment.source === 'microphone').length) {
              throw new Error('Microphone view includes other sources');
            }
            if (meeting.systemAudioUrl) {
              buttons.system.click();
              if (lineCount() !== meeting.transcript.segments.filter(segment => segment.source === 'system').length) {
                throw new Error('System view includes other sources');
              }
            } else if (!buttons.system.hidden) throw new Error('System view visible without system audio');
            buttons.all.click();
            if (lineCount() !== meeting.transcript.segments.length) throw new Error('Merged view missing lines');
            return { microphone, all: lineCount(), viewsVisible: !views.hidden };
          })()`);
          if (!sourceViews?.viewsVisible) throw new Error('Transcript source selector did not appear');
          const latestId = listMeetings()[0]?.id;
          if (!latestId || !fs.existsSync(path.join(app.getPath('userData'), 'meetings', latestId,
            'transcript-microphone.txt'))) throw new Error('Local microphone transcript text missing');
          console.info('Transcript source views smoke passed:', sourceViews);
        }
        if (process.env.MEETING_ASSISTANT_HISTORY_SMOKE === '1') {
          const history = await window?.webContents.executeJavaScript(`(async () => {
            const meetings = await window.meetingAPI.list();
            if (meetings.length < 2) throw new Error('Need two completed meetings for history smoke');
            const selected = meetings[1];
            const expected = await window.meetingAPI.open(selected.id);
            const select = document.querySelector('#meeting-select');
            select.value = selected.id;
            select.dispatchEvent(new Event('change'));
            const player = document.querySelector('#playback');
            const lines = document.querySelector('#transcript-lines');
            const warning = document.querySelector('#transcript-status');
            await new Promise((resolve, reject) => {
              const check = () => player.src === expected.audioUrl && player.readyState >= 1 &&
                (expected.transcript.segments.length === 0 ||
                  lines.textContent.includes(expected.transcript.segments[0].text)) && resolve();
              const observer = new MutationObserver(check);
              observer.observe(lines, { childList: true, subtree: true });
              player.addEventListener('loadedmetadata', check);
              check();
              setTimeout(() => reject(new Error('Older meeting did not load')), 10000);
            });
            if (!warning.textContent.includes('Speaker identities cannot be recovered') &&
                !warning.textContent.includes('Speaker identities are unknown')) {
              throw new Error('Saved meeting lacks speaker attribution warning');
            }
            if (expected.transcript.segments.some(segment => segment.source === 'microphone') &&
                !lines.textContent.includes('speaker unknown')) {
              throw new Error('Saved mic transcript implies speaker identity');
            }
            let rejectedIncomplete = false;
            try { await window.meetingAPI.open('not-a-completed-meeting'); }
            catch { rejectedIncomplete = true; }
            return { selected: select.value, audio: player.src, rejectedIncomplete };
          })()`);
          if (!history || !history.rejectedIncomplete) throw new Error('Meeting history guard failed');
          console.info('Meeting history UI smoke passed:', history);
        }
      } catch (error) {
        console.error('Electron UI/IPC smoke failed:', error);
        process.exitCode = 1;
      } finally {
        app.quit();
      }
    });
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) app.quit();
});

app.on('before-quit', () => {
  if (recording) stopRecording();
});