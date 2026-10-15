(function () {
type RecordingAPI = {
  ping(): Promise<string>;
  list(): Promise<Array<{ id: string; startedAt: string; durationMs: number; inputDevice: string }>>;
  reveal(id: string | null): Promise<void>;
  delete(id: string): Promise<void>;
  analyze(id: string): Promise<string>;
  open(id: string): Promise<{ directory: string; audioUrl: string; systemAudioUrl?: string; transcript: Transcript; aiNotes?: string }>;
  latest(): Promise<{ directory: string; audioUrl: string; systemAudioUrl?: string; transcript: Transcript } | null>;
  start(sampleRate: number, deviceLabel: string, captureSystem: boolean): Promise<{ directory: string }>;
  sendChunk(chunk: Uint8Array): Promise<void>;
  stop(): Promise<{ directory: string; audioUrl: string; systemAudioUrl?: string; durationMs: number; transcript?: Transcript; transcriptionError?: string }>;
};
type Transcript = { text: string; inputDevice?: string; speechActivity?: Array<{
  start: number; end: number
}>; speechActivityBySource?: { microphone: Array<{ start: number; end: number }>;
  system?: Array<{ start: number; end: number }>
}; segments: Array<{
  start: number; end: number; text: string; source: 'microphone' | 'system'
}>; warning?: string };

const meetingAPI = (window as unknown as { meetingAPI: RecordingAPI }).meetingAPI;
const appStatus = document.querySelector<HTMLElement>('#status');
const sourceStatus = document.querySelector<HTMLElement>('#microphone-status');
const systemStatus = document.querySelector<HTMLElement>('#system-status');
const captureSystem = document.querySelector<HTMLInputElement>('#capture-system');
const inputLevel = document.querySelector<HTMLMeterElement>('#input-level');
const signalStatus = document.querySelector<HTMLElement>('#signal-status');
const deviceSelect = document.querySelector<HTMLSelectElement>('#device');
const consent = document.querySelector<HTMLInputElement>('#consent');
const startButton = document.querySelector<HTMLButtonElement>('#start');
const stopButton = document.querySelector<HTMLButtonElement>('#stop');
const timer = document.querySelector<HTMLElement>('#timer');
const savedPath = document.querySelector<HTMLElement>('#saved-path');
const revealButton = document.querySelector<HTMLButtonElement>('#reveal');
const deleteButton = document.querySelector<HTMLButtonElement>('#delete-meeting');
const analyzeButton = document.querySelector<HTMLButtonElement>('#analyze');
const aiStatus = document.querySelector<HTMLElement>('#ai-status');
const aiNotes = document.querySelector<HTMLElement>('#ai-notes');
const transcriptStatus = document.querySelector<HTMLElement>('#transcript-status');
const transcriptLines = document.querySelector<HTMLElement>('#transcript-lines');
const transcriptViews = document.querySelector<HTMLElement>('#transcript-views');
const latestButton = document.querySelector<HTMLButtonElement>('#open-latest');
const meetingSelect = document.querySelector<HTMLSelectElement>('#meeting-select');
const playback = document.querySelector<HTMLAudioElement>('#playback');
const micPlayer = document.querySelector<HTMLElement>('#mic-player');
const systemPlayback = document.querySelector<HTMLAudioElement>('#system-playback');
const systemPlayer = document.querySelector<HTMLElement>('#system-player');

let stream: MediaStream | null = null;
let context: AudioContext | null = null;
let processor: ScriptProcessorNode | null = null;
let active = false;
let busy = false;
let startedAt = 0;
let interval: number | undefined;
let pendingChunk: Promise<void> = Promise.resolve();
let captureError: string | null = null;
let receivedAudio = false;
let meetingRequest = 0;
let currentTranscript: Transcript | null = null;
let selectedSource: 'all' | 'microphone' | 'system' = 'all';

function showStatus(message: string): void {
  if (appStatus) appStatus.textContent = message;
}

function showTranscript(segments: Array<{ start: number; text: string; source: string }>, inputDevice?: string): void {
  if (!transcriptLines) return;
  transcriptLines.replaceChildren();
  for (const segment of segments) {
    const row = document.createElement('div');
    row.className = 'transcript-row';
    const attribution = document.createElement('span');
    attribution.className = 'transcript-attribution';
    const minutes = Math.floor(segment.start / 60).toString().padStart(2, '0');
    const seconds = Math.floor(segment.start % 60).toString().padStart(2, '0');
    attribution.textContent = `${minutes}:${seconds} · ${segment.source === 'microphone'
      ? `Mixed mic audio${inputDevice ? ` (${inputDevice})` : ''} · speaker unknown` : segment.source === 'system'
        ? 'Mixed system playback · app, site and speaker unknown' : 'Source and speaker unknown'}`;
    const text = document.createElement('p');
    text.textContent = segment.text;
    row.append(attribution, text);
    transcriptLines.append(row);
  }
}

function selectTranscriptSource(source: 'all' | 'microphone' | 'system'): void {
  selectedSource = source;
  for (const button of Array.from(transcriptViews?.querySelectorAll<HTMLButtonElement>('button[data-source]') ?? [])) {
    button.setAttribute('aria-pressed', String(button.dataset.source === source));
  }
  if (!currentTranscript) return;
  const segments = source === 'all' ? currentTranscript.segments :
    currentTranscript.segments.filter(segment => segment.source === source);
  showTranscript(segments, currentTranscript.inputDevice);
  if (segments.length === 0 && transcriptLines) {
    const empty = document.createElement('p');
    empty.textContent = `No speech transcribed on the ${source === 'all' ? 'recording' : source + ' track'}.`;
    transcriptLines.append(empty);
  }
}

function displayTranscript(transcript: Transcript, hasSystemTrack: boolean): void {
  currentTranscript = transcript;
  if (transcriptViews) {
    transcriptViews.hidden = false;
    const systemButton = transcriptViews.querySelector<HTMLButtonElement>('button[data-source="system"]');
    if (systemButton) systemButton.hidden = !hasSystemTrack;
  }
  selectTranscriptSource(hasSystemTrack || selectedSource !== 'system' ? selectedSource : 'all');
  if (!transcriptStatus) return;
  const micActivity = transcript.speechActivityBySource?.microphone ?? transcript.speechActivity ?? [];
  const systemActivity = transcript.speechActivityBySource?.system;
  const activity = systemActivity
    ? `VAD: mic ${micActivity.length}, system ${systemActivity.length} speech-like interval(s); music or tones may be included. `
    : `VAD: mic ${micActivity.length} speech-like interval(s); music or tones may be included. `;
  const sourceWarning = hasSystemTrack
    ? 'Speaker identities are unknown on both tracks. Multiple people on the same track are not separated. The mic may also pick up speaker playback; system app and site are unknown. Listen to each recording before using this as a meeting record. '
    : 'Mic-only recording: speech from you, others, or speaker playback is mixed together. Speaker identities cannot be recovered from these labels. Multiple people on one mic are not separated. Listen before using this as a meeting record. ';
  transcriptStatus.textContent = sourceWarning + (transcript.warning || (transcript.segments.length
    ? transcript.segments.every(segment => /^\[[^\]]+\]$/.test(segment.text))
      ? 'Only background sound was recognized; no verified speech transcript.'
      : `${activity}Automatic transcript is unverified and can contain mistakes.`
    : 'No speech recognized. Check the selected microphone and recording.'));
}

function displayAudio(audioUrl: string, systemAudioUrl?: string): void {
  if (playback) { playback.src = audioUrl; playback.hidden = false; }
  if (micPlayer) micPlayer.hidden = false;
  if (systemPlayback) {
    systemPlayback.pause();
    if (systemAudioUrl) systemPlayback.src = systemAudioUrl;
    else systemPlayback.removeAttribute('src');
  }
  if (systemPlayer) systemPlayer.hidden = !systemAudioUrl;
}

async function openMeeting(id: string): Promise<void> {
  if (active || busy) return;
  const request = ++meetingRequest;
  if (transcriptStatus) transcriptStatus.textContent = 'Opening meeting...';
  if (latestButton) latestButton.disabled = true;
  if (meetingSelect) meetingSelect.disabled = true;
  try {
    const meeting = await meetingAPI.open(id);
    if (request !== meetingRequest || active || busy) return;
    if (savedPath) savedPath.textContent = meeting.directory;
    displayAudio(meeting.audioUrl, meeting.systemAudioUrl);
    displayTranscript(meeting.transcript, Boolean(meeting.systemAudioUrl));
    if (aiNotes) { aiNotes.textContent = meeting.aiNotes ?? ''; aiNotes.hidden = !meeting.aiNotes; }
    if (aiStatus) aiStatus.textContent = meeting.aiNotes ? 'Saved AI notes' : '';
  } catch (error) {
    if (request === meetingRequest && transcriptStatus) transcriptStatus.textContent = `Unable to open meeting: ${String(error)}`;
  } finally {
    if (latestButton) latestButton.disabled = false;
    if (meetingSelect) meetingSelect.disabled = false;
  }
}

async function refreshMeetings(preferredId?: string, openSelected = true): Promise<void> {
  const meetings = await meetingAPI.list();
  if (active || busy || !meetingSelect) return;
  const selectedId = preferredId || meetingSelect.value;
  meetingSelect.replaceChildren();
  for (const meeting of meetings) {
    meetingSelect.add(new Option(`${new Date(meeting.startedAt).toLocaleString()} · ${
      Math.round(meeting.durationMs / 1000)}s · ${meeting.inputDevice}`, meeting.id));
  }
  if (!meetings.length) {
    meetingSelect.add(new Option('No saved meetings', ''));
    if (deleteButton) deleteButton.disabled = true;
    if (analyzeButton) analyzeButton.disabled = true;
    if (transcriptStatus) transcriptStatus.textContent = 'No saved meetings yet.';
    return;
  }
  meetingSelect.value = meetings.some(meeting => meeting.id === selectedId) ? selectedId : meetings[0].id;
  if (deleteButton) deleteButton.disabled = false;
  if (analyzeButton) analyzeButton.disabled = false;
  if (openSelected) await openMeeting(meetingSelect.value);
}

async function refreshDevices(): Promise<void> {
  if (!deviceSelect) return;
  try {
    const devices = (await navigator.mediaDevices.enumerateDevices())
      .filter(device => device.kind === 'audioinput');
    const previous = deviceSelect.value;
    deviceSelect.replaceChildren();
    for (const [index, device] of devices.entries()) {
      const option = new Option(device.label || `Microphone ${index + 1}`, device.deviceId);
      deviceSelect.add(option);
    }
    if (devices.some(device => device.deviceId === previous)) deviceSelect.value = previous;
    if (!devices.length) showStatus('No microphone detected. Check your audio devices.');
  } catch (error) {
    showStatus(`Unable to list microphones: ${String(error)}`);
  }
}

function updateTimer(): void {
  if (timer) timer.textContent = new Date(Date.now() - startedAt).toISOString().slice(11, 19);
}

function releaseMicrophone(): void {
  if (interval !== undefined) window.clearInterval(interval);
  interval = undefined;
  processor?.disconnect();
  processor = null;
  stream?.getTracks().forEach(track => track.stop());
  stream = null;
  if (context) void context.close();
  context = null;
  if (inputLevel) inputLevel.value = 0;
  if (signalStatus) signalStatus.textContent = 'Mic stopped';
}

async function stopRecording(): Promise<void> {
  if (!active || busy) return;
  busy = true;
  active = false;
  meetingRequest += 1;
  if (stopButton) stopButton.disabled = true;
  releaseMicrophone();
  if (sourceStatus) sourceStatus.textContent = 'Microphone: stopped';
  showStatus('Transcribing locally...');
  if (transcriptStatus) transcriptStatus.textContent = 'Processing saved audio tracks. The first run downloads a local model.';
  try {
    await pendingChunk;
    const result = await meetingAPI.stop();
    showStatus(captureError ? `Recording saved with an error: ${captureError}` : 'Recording saved');
    if (savedPath) savedPath.textContent = result.directory;
    displayAudio(result.audioUrl, result.systemAudioUrl);
    if (systemStatus) systemStatus.textContent = result.systemAudioUrl ? 'System audio: saved' : 'System audio: not captured';
    if (result.transcriptionError) {
      if (transcriptStatus) transcriptStatus.textContent = `Audio saved, but transcription failed: ${result.transcriptionError}`;
    } else {
      if (result.transcript) displayTranscript(result.transcript, Boolean(result.systemAudioUrl));
    }
  } catch (error) {
    showStatus(`Unable to finish recording: ${String(error)}`);
  } finally {
    busy = false;
    if (startButton) startButton.disabled = !consent?.checked;
    await refreshDevices();
    if (meetingSelect) meetingSelect.value = '';
    await refreshMeetings(undefined, false).catch(error => {
      if (transcriptStatus) transcriptStatus.textContent = `Unable to refresh meetings: ${String(error)}`;
    });
  }
}

async function startRecording(): Promise<void> {
  if (active || busy || !consent?.checked) return;
  busy = true;
  captureError = null;
  receivedAudio = false;
  if (inputLevel) inputLevel.value = 0;
  if (signalStatus) signalStatus.textContent = 'Waiting for mic signal';
  if (playback) { playback.pause(); playback.removeAttribute('src'); playback.hidden = true; }
  if (micPlayer) micPlayer.hidden = true;
  if (systemPlayback) { systemPlayback.pause(); systemPlayback.removeAttribute('src'); }
  if (systemPlayer) systemPlayer.hidden = true;
  if (transcriptLines) transcriptLines.replaceChildren();
  if (transcriptViews) transcriptViews.hidden = true;
  currentTranscript = null;
  selectedSource = 'all';
  if (deleteButton) deleteButton.disabled = true;
  if (analyzeButton) analyzeButton.disabled = true;
  if (aiNotes) { aiNotes.textContent = ''; aiNotes.hidden = true; }
  if (aiStatus) aiStatus.textContent = '';
  if (transcriptStatus) transcriptStatus.textContent = 'Recording selected audio sources. Text appears after you stop.';
  if (startButton) startButton.disabled = true;
  showStatus('Requesting microphone access...');
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: {
      ...(deviceSelect?.value ? { deviceId: { exact: deviceSelect.value } } : {}),
      echoCancellation: true,
      noiseSuppression: true
    }, video: false });
    context = new AudioContext();
    const source = context.createMediaStreamSource(stream);
    processor = context.createScriptProcessor(4096, 1, 1);
    const silence = context.createGain();
    silence.gain.value = 0;
    source.connect(processor);
    processor.connect(silence);
    silence.connect(context.destination);
    await context.resume();
    if (systemStatus) systemStatus.textContent = captureSystem?.checked ? 'System audio: requesting Screen Recording access' : 'System audio: off';
    showStatus(captureSystem?.checked ? 'Starting system playback capture...' : 'Starting microphone capture...');
    await meetingAPI.start(context.sampleRate, stream.getAudioTracks()[0]?.label ?? 'Default microphone', Boolean(captureSystem?.checked));
    pendingChunk = Promise.resolve();
    active = true;
    startedAt = Date.now();
    processor.onaudioprocess = event => {
      if (!active) return;
      const samples = event.inputBuffer.getChannelData(0);
      const chunk = new Uint8Array(samples.length * 2);
      const data = new DataView(chunk.buffer);
      let energy = 0;
      let peak = 0;
      for (let index = 0; index < samples.length; index += 1) {
        const value = Math.max(-1, Math.min(1, samples[index]));
        energy += value * value;
        peak = Math.max(peak, Math.abs(value));
        data.setInt16(index * 2, value < 0 ? value * 32768 : value * 32767, true);
      }
      const rms = Math.sqrt(energy / samples.length);
      if (inputLevel) inputLevel.value = Math.min(1, rms * 5);
      if (signalStatus) signalStatus.textContent = peak > 0.98 ? 'Too loud / clipping' :
        rms < 0.012 ? 'Very quiet - check microphone' : 'Mic signal detected';
      pendingChunk = pendingChunk.then(() => meetingAPI.sendChunk(chunk)).then(() => {
        if (!receivedAudio && active) {
          receivedAudio = true;
          if (sourceStatus) sourceStatus.textContent = 'Microphone: recording';
        }
      }).catch(error => {
        captureError = String(error);
        void stopRecording();
      });
    };
    stream.getAudioTracks()[0]?.addEventListener('ended', () => { void stopRecording(); });
    if (stopButton) stopButton.disabled = false;
    if (sourceStatus) sourceStatus.textContent = 'Microphone: waiting for audio';
    if (systemStatus && captureSystem?.checked) systemStatus.textContent = 'System audio: recording';
    showStatus('Recording started');
    updateTimer();
    interval = window.setInterval(updateTimer, 1000);
    await refreshDevices();
  } catch (error) {
    releaseMicrophone();
    if (systemStatus) systemStatus.textContent = `System audio: unavailable (${String(error)})`;
    showStatus(`Microphone not recording: ${String(error)}`);
  } finally {
    busy = false;
    if (!active && startButton) startButton.disabled = !consent.checked;
  }
}

if (appStatus) {
  meetingAPI.ping().then(() => {
    showStatus('Ready to record');
    void refreshMeetings().catch(error => {
      if (transcriptStatus) transcriptStatus.textContent = `Unable to load meetings: ${String(error)}`;
    });
  }).catch(() => {
    showStatus('Application connection failed');
  });
}

void refreshDevices();
consent?.addEventListener('change', () => {
  if (startButton) startButton.disabled = !consent.checked || busy || active;
});
startButton?.addEventListener('click', () => { void startRecording(); });
stopButton?.addEventListener('click', () => { void stopRecording(); });
latestButton?.addEventListener('click', () => {
  if (meetingSelect) meetingSelect.value = '';
  void refreshMeetings().catch(error => {
    if (transcriptStatus) transcriptStatus.textContent = `Unable to load meetings: ${String(error)}`;
  });
});
meetingSelect?.addEventListener('change', () => { if (meetingSelect.value) void openMeeting(meetingSelect.value); });
revealButton?.addEventListener('click', () => {
  void meetingAPI.reveal(meetingSelect?.value || null).catch(error => showStatus(`Unable to show folder: ${String(error)}`));
});
deleteButton?.addEventListener('click', () => {
  const id = meetingSelect?.value;
  if (!id || active || busy || !window.confirm('Permanently delete this meeting, its audio, transcript and AI notes?')) return;
  busy = true;
  meetingRequest += 1;
  deleteButton.disabled = true;
  if (analyzeButton) analyzeButton.disabled = true;
  void meetingAPI.delete(id).then(async () => {
    playback?.pause(); playback?.removeAttribute('src');
    systemPlayback?.pause(); systemPlayback?.removeAttribute('src');
    if (micPlayer) micPlayer.hidden = true;
    if (systemPlayer) systemPlayer.hidden = true;
    if (savedPath) savedPath.textContent = 'Documents/Meeting Assistant/meetings';
    if (transcriptLines) transcriptLines.replaceChildren();
    if (transcriptViews) transcriptViews.hidden = true;
    if (aiNotes) { aiNotes.textContent = ''; aiNotes.hidden = true; }
    if (aiStatus) aiStatus.textContent = '';
    busy = false;
    await refreshMeetings(undefined, true);
    showStatus('Meeting deleted');
  }).catch(error => { busy = false; showStatus(`Unable to delete meeting: ${String(error)}`); void refreshMeetings(id, false); });
});
analyzeButton?.addEventListener('click', () => {
  const id = meetingSelect?.value;
  if (!id || active || busy || !window.confirm('Send this meeting transcript text to the configured GLM service for AI notes? Audio will not be sent.')) return;
  busy = true;
  analyzeButton.disabled = true;
  if (deleteButton) deleteButton.disabled = true;
  if (meetingSelect) meetingSelect.disabled = true;
  if (latestButton) latestButton.disabled = true;
  if (aiStatus) aiStatus.textContent = 'Sending transcript and generating notes...';
  void meetingAPI.analyze(id).then(notes => {
    if (aiNotes) { aiNotes.textContent = notes; aiNotes.hidden = false; }
    if (aiStatus) aiStatus.textContent = 'AI notes saved in this meeting folder.';
  }).catch(error => { if (aiStatus) aiStatus.textContent = `AI analysis failed: ${String(error)}`; })
    .finally(() => {
      busy = false;
      if (analyzeButton) analyzeButton.disabled = false;
      if (deleteButton) deleteButton.disabled = false;
      if (meetingSelect) meetingSelect.disabled = false;
      if (latestButton) latestButton.disabled = false;
    });
});
transcriptViews?.addEventListener('click', event => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-source]');
  if (!button || button.hidden) return;
  const source = button.dataset.source;
  if (source === 'all' || source === 'microphone' || source === 'system') selectTranscriptSource(source);
});
})();