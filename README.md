# Meeting Assistant (first build)

Local-first macOS microphone and system-playback recorder with offline, post-recording speech recognition. Audio is not uploaded. The first use downloads a multilingual Whisper model into the app's user-data `models` directory; recognition then runs locally. This is a development build, not a packaged DMG.

## Run

Requires Node.js, npm, Xcode Command Line Tools (`swiftc`), and macOS with ScreenCaptureKit.

```sh
npm install
npm start
```

Select a microphone, choose whether to capture system playback (on by default), confirm recording consent, and press Start. Grant microphone access to Electron and macOS Screen Recording access to the system capture helper when prompted. If Screen Recording is denied, Start fails; uncheck system capture to record only the mic. After granting access you may need to restart the app. While recording, the input meter measures only the selected microphone. Press Stop to finish; each track is transcribed offline and timed lines are merged with capture-source labels. Use the All, Microphone, and System controls to review the corresponding transcript lines. Separate players allow checking `microphone.wav` and `system.wav` (16-bit, mono PCM). Completed meetings are available in the Saved meetings selector; choose an earlier meeting to load its audio and transcript. Each meeting also contains `meeting.json`, per-source `transcript-*.json` and `transcript-*.txt`, plus merged `transcript.txt` and `transcript.json` after recognition. New recordings are saved in `~/Documents/Meeting Assistant/meetings`, one folder per meeting. Show in Finder opens the selected meeting's location, and Delete meeting permanently removes its audio, transcripts and AI notes after confirmation. Older meetings under Electron's Application Support `meetingassistant/meetings` remain available in the selector; nothing is moved or deleted automatically. If recognition fails, audio remains saved and you can retry opening the meeting; if only system recognition fails, the mic transcript is saved with an explicit incomplete warning. The app does not use or modify the Downloads reference project at runtime.

## Optional AI notes

The Analyze transcript with AI button sends **only the complete saved transcript text**, never audio, to the configured Bedrock Mantle OpenAI-compatible GLM endpoint after a confirmation. Notes are saved as `ai-notes.txt` in that meeting's folder; the original transcript is unchanged. Configure the same server-side variables as smartyAi before launching the app, for example:

```sh
export BEDROCK_MANTLE_API_KEY='your-key'
export BEDROCK_MANTLE_ENDPOINT='https://your-bedrock-mantle-endpoint/v1'
export BEDROCK_MODEL='zai.glm-5'
npm start
```

The endpoint must use HTTPS and include the API base path; the app posts to `/chat/completions`. No key is stored in the meeting folder or exposed to the renderer. Do not use this action for confidential meetings without authorization. AI notes can be inaccurate; verify them against the audio and transcript. Oversized or incomplete transcripts are refused rather than silently shortened. Without configuration, local recording and offline transcription still work.

To validate both tracks on your Mac: play a short YouTube clip while speaking into the mic for at least 30 seconds, stop, then play each WAV separately from the displayed directory. The YouTube playback should appear in the system WAV and your voice in the mic WAV. VAD counts for mic and system are displayed separately after transcription. The mic requests echo cancellation and noise suppression, but it can still pick up sound from speakers in the room; headphones help prevent this. VAD does not identify who is speaking. A very quiet mic signal may not transcribe reliably.

## Checks

```sh
npm run typecheck
npm test
```

## Current limits

- System capture uses macOS ScreenCaptureKit and has not yet been verified with actual system playback on this Mac. The app cannot recover system audio if Screen Recording permission is denied or the stream is silent.
- Speech recognition runs after Stop, not live. It can make mistakes and must be reviewed before business use. Voice activity detection can mistake music for speech.
- No speaker diarization, DMG packaging, or Windows validation yet. Three people can be recorded if their voices reach the selected mic or system capture, but only two capture sources are available. Multiple people sharing a source cannot be labeled as separate speakers; capture-source labels are not speaker identities.
- System playback is one mixed macOS audio stream. It cannot identify which browser tab, website (including YouTube), or application produced a sound. The mic may also capture speaker playback, so the same sound can appear on both tracks. Verified site attribution would require a separate, consented browser integration or tab-specific capture; the audio alone cannot establish it.
- The development app uses Electron's generic microphone permission description. A packaged build will need its own macOS privacy metadata and signing decisions.

# smarty-meeting