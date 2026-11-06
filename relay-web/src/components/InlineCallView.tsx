"use client";

import { useRef, useEffect, useMemo, useState, useCallback } from "react";
import { useCall } from "@/context/CallContext";
import { useIdentity } from "@/context/IdentityContext";
import { getParticipantSources, type ParticipantSource } from "@/lib/callUtils";
import { AbsentTile, useAbsentMembers } from "@/components/AbsentMembers";
import { CallControls } from "@/components/CallControls";

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
  onVolume,
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
  /** Opens this person's volume: right-click, or a long press on a touch screen. */
  onVolume?: (x: number, y: number) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pressed = useRef(false);
  const endPress = () => {
    if (pressTimer.current) clearTimeout(pressTimer.current);
    pressTimer.current = null;
  };
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
      onClick={() => {
        if (pressed.current) {
          pressed.current = false;
          return;
        }
        onClick();
      }}
      onContextMenu={
        onVolume
          ? (e) => {
              e.preventDefault();
              if (!pressed.current) onVolume(e.clientX, e.clientY);
            }
          : undefined
      }
      onPointerDown={(e) => {
        pressed.current = false;
        if (!onVolume || e.pointerType === "mouse") return;
        const { clientX, clientY } = e;
        pressTimer.current = setTimeout(() => {
          pressed.current = true;
          onVolume(clientX, clientY);
        }, 500);
      }}
      onPointerUp={endPress}
      onPointerLeave={endPress}
      onPointerCancel={endPress}
      style={{ WebkitTouchCallout: "none" }}
      className={`select-none relative rounded overflow-hidden bg-black flex items-center justify-center transition-all w-full h-full min-h-0 ${
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
export function InlineCallView({ onHangUp, top }: { onHangUp: () => void; /** Banners shown above the tiles. */ top?: React.ReactNode }) {
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
    setCallExpanded,
  } = useCall();
  const { getDisplayName, getMyDisplayName, getContactVolume, setContactVolume } = useIdentity();
  const absent = useAbsentMembers();
  const [volumeMenu, setVolumeMenu] = useState<{ keyHash: string; x: number; y: number } | null>(null);
  const volumeMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!volumeMenu) return;
    const close = (e: PointerEvent) => {
      if (volumeMenuRef.current?.contains(e.target as Node)) return;
      setVolumeMenu(null);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setVolumeMenu(null);
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", onKey);
    };
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
        onVolume={keyHash ? (x, y) => setVolumeMenu({ keyHash, x, y }) : undefined}
      />
    );
  };

  return (
    <div className="flex-1 flex flex-col min-h-0 relative" style={{ paddingTop: "max(0.5rem, env(safe-area-inset-top, 0px))" }}>
      {top}
      {volumeMenu && (
        <div
          ref={volumeMenuRef}
          role="dialog"
          aria-label="Volume"
          className="fixed z-[100] rounded-lg bg-[var(--surface)] border border-[var(--border)] shadow-lg p-3 w-[200px]"
          style={{
            left: Math.max(8, Math.min(volumeMenu.x, window.innerWidth - 208)),
            top: Math.max(8, Math.min(volumeMenu.y, window.innerHeight - 110)),
          }}
        >
          <div className="text-xs text-[var(--muted)] mb-2 truncate">Volume: {getDisplayName(volumeMenu.keyHash) || volumeMenu.keyHash.slice(0, 8)}</div>
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
        <div className="flex-1 min-h-0 flex flex-col px-2">
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
            {absent.map((k) => (
              <div key={k} className="flex-shrink-0 w-32 h-24">
                <AbsentTile keyHash={k} />
              </div>
            ))}
          </div>
        </div>
      ) : (
        // However many people: the tiles scroll, the controls below stay put.
        <div className="flex-1 min-h-0 overflow-auto px-2 pb-2">
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3 content-start">
            {tiles.map((tile) => (
              <div
                key={tile.key}
                className="rounded overflow-hidden bg-[var(--surface)] border border-[var(--border)] aspect-video flex flex-col min-h-0"
              >
                {renderTile(tile)}
              </div>
            ))}
            {absent.map((k) => (
              <div key={k} className="aspect-video min-h-0" aria-label="Not in the call">
                <AbsentTile keyHash={k} />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Phones: the controls at the bottom of the screen. Desktop has them in the sidebar, and the chat is a click away there. */}
      <div
        className="md:hidden flex-shrink-0 px-2 pt-2 border-t border-[var(--border)] bg-[var(--bg)]"
        style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 0.5rem)" }}
      >
        <CallControls onHangUp={onHangUp} onChat={() => setCallExpanded(false)} />
      </div>
    </div>
  );
}
