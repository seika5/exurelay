"use client";

import { useRef, useEffect, useMemo, useState, useCallback } from "react";
import { useCall } from "@/context/CallContext";
import { useIdentity } from "@/context/IdentityContext";
import { getParticipantSources, type ParticipantSource } from "@/lib/callUtils";
import { AbsentMembers } from "@/components/AbsentMembers";

const VOLUME_MIN = 0;
const VOLUME_MAX = 100;

function ParticipantTile({
  sourceKey,
  participantId,
  isLocal,
  stream,
  displayLetter,
  displayName,
  speaking,
  focused,
  onClick,
  deafened,
  keyHash,
  volume,
  onContextMenu,
}: {
  sourceKey: string;
  participantId: string;
  isLocal: boolean;
  stream: MediaStream | null;
  displayLetter: string;
  displayName: string;
  speaking: boolean;
  focused: boolean;
  onClick: () => void;
  deafened?: boolean;
  keyHash?: string;
  volume?: number;
  onContextMenu?: (e: React.MouseEvent) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const [aspectRatio, setAspectRatio] = useState(16 / 9);
  const gain = typeof volume === "number" ? Math.min(1, volume / 100) : 1;
  const hasVideo = !!stream?.getVideoTracks().length;
  const onVideoLoadedMetadata = useCallback(() => {
    const v = videoRef.current;
    if (v && v.videoWidth && v.videoHeight) setAspectRatio(v.videoWidth / v.videoHeight);
  }, []);
  useEffect(() => {
    if (stream && videoRef.current) videoRef.current.srcObject = stream;
    return () => {
      if (videoRef.current) videoRef.current.srcObject = null;
    };
  }, [stream]);
  useEffect(() => {
    if (stream && audioRef.current && !isLocal && !deafened) {
      audioRef.current.srcObject = stream;
      audioRef.current.volume = gain;
    }
    return () => {
      if (audioRef.current) audioRef.current.srcObject = null;
    };
  }, [stream, isLocal, deafened, gain]);
  useEffect(() => {
    if (audioRef.current && !isLocal) audioRef.current.volume = gain;
  }, [gain, isLocal]);
  useEffect(() => {
    if (videoRef.current && hasVideo && !isLocal) videoRef.current.volume = gain;
  }, [gain, isLocal, hasVideo]);

  return (
    <button
      type="button"
      onClick={onClick}
      onContextMenu={onContextMenu}
      className={`relative rounded overflow-hidden bg-black flex items-center justify-center transition-all w-full h-full min-h-0 ${
        focused ? "ring-2 ring-white ring-offset-2 ring-offset-[var(--bg)]" : ""
      } ${speaking ? "ring-2 ring-white" : ""}`}
    >
      {!isLocal && stream && stream.getAudioTracks().length > 0 && !hasVideo && (
        <audio ref={audioRef} autoPlay playsInline className="hidden" />
      )}
      {hasVideo && stream ? (
        <div className="w-full h-full flex items-center justify-center" style={{ aspectRatio }}>
          <video
            ref={videoRef}
            autoPlay
            muted={isLocal || deafened}
            playsInline
            onLoadedMetadata={onVideoLoadedMetadata}
            className="w-full h-full object-contain"
          />
        </div>
      ) : (
        <span className="text-4xl font-bold text-[var(--muted)]">{displayLetter}</span>
      )}
      <span className="absolute bottom-0 left-0 text-xs text-white bg-black/60 px-1.5 py-0.5 truncate max-w-full">
        {displayName}
      </span>
    </button>
  );
}

/**
 * Inline call view. Discord-style: one tile per video source (camera + screen); name in bottom left. Click to focus.
 * On mobile, the controls bar at the bottom replaces the sidebar controls (which are hidden).
 */
export function InlineCallView({ onHangUp }: { onHangUp?: () => void }) {
  const {
    localStream,
    remoteStreams,
    peers,
    peerKeyHashes,
    peerMutedDeafened,
    cameraOn,
    screenSharing,
    cameraTrackRef,
    screenTrackRef,
    muted,
    deafened,
    speaking,
    focusedPeerId,
    setFocusedPeerId,
    setMuted,
    setDeafened,
    setCameraOn,
    setScreenSharing,
    setCallExpanded,
  } = useCall();
  const { getDisplayName, getMyDisplayName, getContactVolume, setContactVolume } = useIdentity();
  const [volumeMenu, setVolumeMenu] = useState<{ keyHash: string; x: number; y: number } | null>(null);
  const volumeMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!volumeMenu) return;
    const close = (e: MouseEvent) => {
      if (volumeMenuRef.current?.contains(e.target as Node)) return;
      setVolumeMenu(null);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [volumeMenu]);

  const sources = useMemo(
    () =>
      getParticipantSources(
        localStream,
        remoteStreams,
        cameraOn,
        screenSharing,
        cameraTrackRef,
        screenTrackRef
      ),
    [localStream, remoteStreams, cameraOn, screenSharing, cameraTrackRef, screenTrackRef]
  );

  const participantIds = ["local", ...Array.from(peers)];

  const getDisplayNameForParticipant = (participantId: string) => {
    const isLocal = participantId === "local";
    const keyHash = isLocal ? undefined : peerKeyHashes.get(participantId);
    let name = isLocal ? getMyDisplayName() : (keyHash && getDisplayName(keyHash)) || participantId.slice(0, 8);
    const statusParts: string[] = [];
    if (isLocal) {
      if (muted) statusParts.push("muted");
      if (deafened) statusParts.push("deafened");
    } else {
      const state = peerMutedDeafened.get(participantId);
      if (state?.muted) statusParts.push("muted");
      if (state?.deafened) statusParts.push("deafened");
    }
    if (statusParts.length) name += ` (${statusParts.join(", ")})`;
    return name;
  };

  type Tile = ParticipantSource & { displayName: string; displayLetter: string };
  const tiles: (Omit<Tile, "stream"> & { stream: MediaStream | null })[] = [];
  for (const id of participantIds) {
    const partSources = sources.filter((s) => s.participantId === id);
    const displayName = getDisplayNameForParticipant(id);
    const displayLetter = displayName[0]?.toUpperCase() ?? "?";
    if (partSources.length > 0) {
      partSources.forEach((s) =>
        tiles.push({
          ...s,
          displayName,
          displayLetter,
        })
      );
    } else {
      tiles.push({
        key: id,
        participantId: id,
        isLocal: id === "local",
        stream: (id === "local" ? localStream : remoteStreams.get(id)) ?? null,
        displayName,
        displayLetter,
      });
    }
  }

  const focusedId = focusedPeerId && participantIds.includes(focusedPeerId) ? focusedPeerId : null;
  const focusedTiles = focusedId ? tiles.filter((t) => t.participantId === focusedId) : [];
  const otherTiles = focusedId ? tiles.filter((t) => t.participantId !== focusedId) : [];

  const renderTile = (tile: (Omit<Tile, "stream"> & { stream: MediaStream | null })) => {
    const keyHash = tile.participantId === "local" ? undefined : peerKeyHashes.get(tile.participantId);
    const volume = keyHash != null ? getContactVolume(keyHash) : undefined;
    return (
      <ParticipantTile
        key={tile.key}
        sourceKey={tile.key}
        participantId={tile.participantId}
        isLocal={tile.isLocal}
        stream={tile.stream}
        displayLetter={tile.displayLetter}
        displayName={tile.displayName}
        speaking={speaking.has(tile.participantId)}
        focused={tile.participantId === focusedId}
        onClick={() => setFocusedPeerId(tile.participantId === focusedId ? null : tile.participantId)}
        deafened={deafened}
        keyHash={keyHash}
        volume={volume}
        onContextMenu={
          keyHash
            ? (e) => {
                e.preventDefault();
                setVolumeMenu({ keyHash, x: e.clientX, y: e.clientY });
              }
            : undefined
        }
      />
    );
  };

  return (
    <div className="flex-1 flex flex-col min-h-0 p-2 overflow-auto relative">
      {volumeMenu && (
        <div
          ref={volumeMenuRef}
          className="fixed z-[100] rounded-lg bg-[var(--surface)] border border-[var(--border)] shadow-lg p-3 min-w-[180px]"
          style={{ left: volumeMenu.x, top: volumeMenu.y }}
        >
          <div className="text-xs text-[var(--muted)] mb-2">Volume</div>
          <input
            type="range"
            min={VOLUME_MIN}
            max={VOLUME_MAX}
            value={getContactVolume(volumeMenu.keyHash)}
            onChange={(e) => setContactVolume(volumeMenu.keyHash, Number(e.target.value))}
            className="w-full accent-[var(--text)]"
          />
          <div className="text-xs text-[var(--text)] mt-1">
            {getContactVolume(volumeMenu.keyHash)}%
          </div>
        </div>
      )}
      {focusedId && focusedTiles.length > 0 ? (
        <>
          <div className="flex-1 min-h-0 rounded overflow-hidden mb-2 flex gap-2">
            {focusedTiles.map((t) => (
              <div key={t.key} className="flex-1 min-h-0 min-w-0">
                {renderTile(t)}
              </div>
            ))}
          </div>
          <div className="flex gap-2 overflow-x-auto pb-2 flex-shrink-0">
            {otherTiles.map((tile) => (
              <div key={tile.key} className="flex-shrink-0 w-32 h-24">
                {renderTile(tile)}
              </div>
            ))}
          </div>
        </>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3 content-start">
          {tiles.map((tile) => (
            <div
              key={tile.key}
              className="rounded overflow-hidden bg-[var(--surface)] border border-[var(--border)] aspect-video flex flex-col min-h-0"
            >
              {renderTile(tile)}
            </div>
          ))}
        </div>
      )}
      <AbsentMembers />

      {/* Call controls — always visible so mobile users are not stuck without controls */}
      <div
        className="flex-shrink-0 flex items-center justify-between gap-1.5 pt-2 mt-2 border-t border-[var(--border)]"
        style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 0.5rem)" }}
      >
        {/* Minimize — collapse back to the compact tile / chat view */}
        <button
          type="button"
          onClick={() => setCallExpanded(false)}
          className="flex-1 py-2 rounded text-sm font-medium bg-[var(--border)] text-[var(--text)] hover:opacity-80"
          title="Minimize call"
        >
          ↙ Chat
        </button>

        <button
          type="button"
          onClick={() => setMuted(!muted)}
          className={`flex-1 py-2 rounded text-sm font-medium ${muted ? "bg-amber-600/80 text-white" : "bg-[var(--border)] text-[var(--text)]"}`}
        >
          {muted ? "Unmute" : "Mute"}
        </button>

        <button
          type="button"
          onClick={() => setDeafened(!deafened)}
          className={`flex-1 py-2 rounded text-sm font-medium ${deafened ? "bg-amber-600/80 text-white" : "bg-[var(--border)] text-[var(--text)]"}`}
        >
          {deafened ? "Undeaf" : "Deafen"}
        </button>

        <button
          type="button"
          onClick={() => setCameraOn(!cameraOn)}
          className={`flex-1 py-2 rounded text-sm font-medium ${cameraOn ? "bg-amber-600/80 text-white" : "bg-[var(--border)] text-[var(--text)]"}`}
        >
          {cameraOn ? "Cam off" : "Camera"}
        </button>

        <button
          type="button"
          onClick={() => onHangUp?.()}
          className="flex-1 py-2 rounded text-sm font-medium bg-red-600/80 text-white hover:opacity-90"
        >
          Hang up
        </button>
      </div>
    </div>
  );
}
