"use client";

import { useEffect, useRef, useState } from "react";

const SPEAKING_THRESHOLD = 0.015;
const POLL_MS = 100;

/**
 * Detect who is currently speaking from audio levels.
 * Returns speaking set (ids with audio above threshold) and lastSpokeId:
 * - Only update lastSpokeId when "last spoke" stops speaking and someone else is still speaking.
 */
export function useSpeakingDetection(
  localStream: MediaStream | null,
  remoteStreams: Map<string, MediaStream>,
  muted: boolean
): { speaking: Set<string>; lastSpokeId: string | null } {
  const [speaking, setSpeaking] = useState<Set<string>>(new Set());
  const [lastSpokeId, setLastSpokeId] = useState<string | null>(null);
  const analysersRef = useRef<Map<string, { ctx: AudioContext; analyser: AnalyserNode; source: MediaStreamAudioSourceNode }>>(new Map());
  const lastSpokeRef = useRef<string | null>(null);

  useEffect(() => {
    const streams = new Map<string, MediaStream>();
    if (localStream && !muted) streams.set("local", localStream);
    remoteStreams.forEach((s, id) => streams.set(id, s));

    const cleanup: (() => void)[] = [];

    streams.forEach((stream, id) => {
      const audioTracks = stream.getAudioTracks();
      if (audioTracks.length === 0) return;
      try {
        const ctx = new AudioContext();
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.5;
        source.connect(analyser);
        analysersRef.current.set(id, { ctx, analyser, source });
        cleanup.push(() => {
          source.disconnect();
          ctx.close();
          analysersRef.current.delete(id);
        });
      } catch {
        // ignore
      }
    });

    let rafId: number;
    const dataArray = new Uint8Array(256);

    const tick = () => {
      const nowSpeaking = new Set<string>();
      analysersRef.current.forEach(({ ctx, analyser }, id) => {
        if (ctx.state === "closed") return;
        analyser.getByteTimeDomainData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
          const n = (dataArray[i] - 128) / 128;
          sum += n * n;
        }
        const rms = Math.sqrt(sum / dataArray.length);
        if (rms > SPEAKING_THRESHOLD) nowSpeaking.add(id);
      });

      setSpeaking(nowSpeaking);

      setLastSpokeId((prev) => {
        const last = lastSpokeRef.current ?? prev;
        if (last != null && nowSpeaking.has(last)) return last;
        if (nowSpeaking.size > 0) {
          const next = Array.from(nowSpeaking)[0];
          lastSpokeRef.current = next;
          return next;
        }
        lastSpokeRef.current = last;
        return last;
      });

      rafId = setTimeout(tick, POLL_MS) as unknown as number;
    };
    tick();

    return () => {
      clearTimeout(rafId);
      lastSpokeRef.current = null;
      cleanup.forEach((c) => c());
    };
  }, [localStream, muted, remoteStreams]);

  return { speaking, lastSpokeId };
}
