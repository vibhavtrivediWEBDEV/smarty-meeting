import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('meetingAPI', Object.freeze({
  ping: (): Promise<string> => ipcRenderer.invoke('app:ping'),
  list: (): Promise<Array<{ id: string; startedAt: string; durationMs: number; inputDevice: string }>> =>
    ipcRenderer.invoke('meeting:list'),
  reveal: (id: string | null): Promise<void> => ipcRenderer.invoke('meeting:reveal', id),
  delete: (id: string): Promise<void> => ipcRenderer.invoke('meeting:delete', id),
  analyze: (id: string): Promise<string> => ipcRenderer.invoke('meeting:analyze', id),
  open: (id: string): Promise<{ directory: string; audioUrl: string; systemAudioUrl?: string; aiNotes?: string; transcript: {
    text: string; inputDevice?: string; speechActivity?: Array<{ start: number; end: number }>;
    segments: Array<{ start: number; end: number; text: string; source: 'microphone' | 'system' }>;
    warning?: string
  } }> => ipcRenderer.invoke('meeting:open', id),
  latest: (): Promise<{ directory: string; audioUrl: string; systemAudioUrl?: string; transcript: {
    text: string; inputDevice?: string; speechActivity?: Array<{ start: number; end: number }>;
    segments: Array<{ start: number; end: number; text: string; source: 'microphone' | 'system' }>;
    warning?: string
  } } | null> => ipcRenderer.invoke('meeting:latest'),
  start: (sampleRate: number, deviceLabel: string, captureSystem: boolean): Promise<{ directory: string }> =>
    ipcRenderer.invoke('recording:start', { consentConfirmed: true, sampleRate, deviceLabel, captureSystem }),
  sendChunk: (chunk: Uint8Array): Promise<void> => ipcRenderer.invoke('recording:chunk', chunk),
  stop: (): Promise<{ directory: string; audioUrl: string; systemAudioUrl?: string; durationMs: number; transcript?: {
    text: string; inputDevice?: string; speechActivity?: Array<{ start: number; end: number }>;
    segments: Array<{ start: number; end: number; text: string; source: 'microphone' | 'system' }>;
    warning?: string
  }; transcriptionError?: string }> => ipcRenderer.invoke('recording:stop')
}));