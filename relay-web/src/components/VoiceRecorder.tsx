"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@/components/icons";
import { btn, btnPrimary } from "@/components/ui";
import { isIOS } from "@/lib/platform";
import { MAX_VOICE_MS, formatElapsed, pickVoiceType, voiceName } from "@/lib/voice";

type Recording = { recorder: MediaRecorder; stream: MediaStream; chunks: Blob[]; send: boolean };

const stopTracks = (s: MediaStream) => s.getTracks().forEach((t) => t.stop());

/** Safari (every iPhone browser is): records MP4, which iPhones play best. */
const preferMp4 = () => isIOS() || (/Safari\//.test(navigator.userAgent) && !/Chrome|Chromium|Edg|Android/.test(navigator.userAgent));

/**
 * Record a voice message. `onDone` gets the recording as a file ("voice-….m4a" or ".webm") when it's sent; it stops
 * by itself and sends at 5 minutes. The microphone is released as soon as recording ends.
 */
export function useVoiceRecorder(onDone: (file: File) => void) {
  const rec = useRef<Recording | null>(null);
  const done = useRef(onDone);
  done.current = onDone;
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // While asking for the mic: a second tap doesn't start a second recording.
  const starting = useRef(false);
  const mounted = useRef(true);

  const stop = useCallback((send: boolean) => {
    const r = rec.current;
    if (!r) return;
    r.send = send;
    if (r.recorder.state !== "inactive") r.recorder.stop();
    else stopTracks(r.stream);
  }, []);

  const start = async () => {
    if (rec.current || starting.current) return;
    setError(null);
    if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setError("Can't record here");
      return;
    }
    let stream: MediaStream;
    starting.current = true;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      const name = (e as DOMException)?.name;
      setError(name === "NotAllowedError" || name === "SecurityError" ? "Mic blocked" : "No mic found");
      return;
    } finally {
      starting.current = false;
    }
    if (!mounted.current) {
      stopTracks(stream);
      return;
    }
    const type = pickVoiceType((t) => MediaRecorder.isTypeSupported(t), preferMp4());
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
    } catch {
      stopTracks(stream);
      setError("Can't record here");
      return;
    }
    const r: Recording = { recorder, stream, chunks: [], send: false };
    rec.current = r;
    recorder.ondataavailable = (e) => e.data.size && r.chunks.push(e.data);
    recorder.onstop = () => {
      stopTracks(stream);
      rec.current = null;
      setStartedAt(null);
      if (!r.send || !r.chunks.length) return;
      const mime = recorder.mimeType || type || "audio/mp4";
      const blob = new Blob(r.chunks, { type: mime.split(";")[0] });
      done.current(new File([blob], voiceName(mime), { type: blob.type }));
    };
    recorder.onerror = () => {
      stop(false);
      setError("Recording failed");
    };
    // In slices, so a long recording isn't held in one piece until the end.
    recorder.start(1000);
    setNow(Date.now());
    setStartedAt(Date.now());
  };

  // The clock, and the 5-minute limit.
  useEffect(() => {
    if (startedAt === null) return;
    const tick = setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (t - startedAt >= MAX_VOICE_MS) stop(true);
    }, 250);
    return () => clearInterval(tick);
  }, [startedAt, stop]);

  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 4000);
    return () => clearTimeout(t);
  }, [error]);

  // Leaving the chat screen drops a recording in progress (and frees the mic).
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      stop(false);
    };
  }, [stop]);

  return {
    recording: startedAt !== null,
    elapsed: startedAt === null ? 0 : Math.min(MAX_VOICE_MS, now - startedAt),
    error,
    start,
    cancel: () => stop(false),
    send: () => stop(true),
  };
}

export type VoiceRecorder = ReturnType<typeof useVoiceRecorder>;

const square = "flex-shrink-0 h-[42px] w-[42px] p-0";

/** Starts recording; in the composer in place of Send while the message box is empty. */
export function MicButton({ voice }: { voice: VoiceRecorder }) {
  return (
    <button type="button" onClick={voice.start} aria-label="Record voice message" title="Record voice message" className={`${btnPrimary} ${square}`}>
      <Icon name="callMic" size={18} />
    </button>
  );
}

/** Takes the composer row's place while recording: cancel, the time so far, send. */
export function RecordingBar({ voice }: { voice: VoiceRecorder }) {
  return (
    <div className="flex items-center gap-2">
      <button type="button" onClick={voice.cancel} aria-label="Cancel recording" title="Cancel recording" className={`${btn} ${square}`}>
        <Icon name="close" size={18} />
      </button>
      <div
        role="timer"
        aria-label="Recording"
        className="flex-1 min-w-0 h-[42px] flex items-center gap-2 px-3 rounded border border-[var(--border)] bg-[var(--surface)]"
      >
        <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-red-500 animate-pulse" aria-hidden />
        <span className="text-sm tabular-nums">{formatElapsed(voice.elapsed)}</span>
        <span className="text-xs text-[var(--muted)] tabular-nums">/ {formatElapsed(MAX_VOICE_MS)}</span>
      </div>
      <button type="button" onClick={voice.send} aria-label="Send voice message" title="Send voice message" className={`${btnPrimary} ${square}`}>
        <Icon name="chatSend" size={18} />
      </button>
    </div>
  );
}
