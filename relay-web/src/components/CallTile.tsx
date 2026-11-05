"use client";

import { useRef, useEffect, useMemo } from "react";
import { useCall } from "@/context/CallContext";
import { useIdentity } from "@/context/IdentityContext";
import { getParticipantSources } from "@/lib/callUtils";

/**
 * Small rectangle showing one video source of the person who last spoke (prefer screen if sharing). Click to expand.
 */
export function CompactCallTile() {
  const { localStream, remoteStreams, lastSpokeId, cameraOn, screenSharing, cameraTrackRef, screenTrackRef, peerKeyHashes, setCallExpanded } = useCall();
  const { getDisplayName, getMyDisplayName } = useIdentity();
  const videoRef = useRef<HTMLVideoElement>(null);

  const id = lastSpokeId ?? "local";
  const sources = useMemo(
    () =>
      getParticipantSources(localStream, remoteStreams, cameraOn, screenSharing, cameraTrackRef, screenTrackRef),
    [localStream, remoteStreams, cameraOn, screenSharing, cameraTrackRef, screenTrackRef]
  );
  const preferredSource = useMemo(() => {
    const forParticipant = sources.filter((s) => s.participantId === id);
    return forParticipant.find((s) => s.key.includes("screen")) ?? forParticipant[0] ?? null;
  }, [sources, id]);

  const isLocal = id === "local";
  const stream = preferredSource?.stream ?? (isLocal ? localStream : remoteStreams.get(id)) ?? null;
  const keyHash = isLocal ? undefined : peerKeyHashes.get(id);
  const displayName = isLocal ? getMyDisplayName() : (keyHash && getDisplayName(keyHash)) || (id ? id.slice(0, 8) + "…" : "?");
  const initial = displayName[0]?.toUpperCase() ?? "?";
  const hasVideo = !!stream?.getVideoTracks().length;

  useEffect(() => {
    if (stream && videoRef.current) videoRef.current.srcObject = stream;
    return () => {
      if (videoRef.current) videoRef.current.srcObject = null;
    };
  }, [stream]);

  return (
    <button
      type="button"
      onClick={() => setCallExpanded(true)}
      className="w-full aspect-video max-h-24 rounded overflow-hidden bg-[var(--border)] border border-[var(--border)] flex items-center justify-center hover:ring-2 hover:ring-[var(--accent)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
      title="Open call"
      aria-label="Open call"
    >
      {hasVideo && stream ? (
        <video
          ref={videoRef}
          autoPlay
          muted
          playsInline
          className="w-full h-full object-cover"
        />
      ) : (
        <span className="text-2xl font-bold text-[var(--muted)]">{initial}</span>
      )}
    </button>
  );
}
