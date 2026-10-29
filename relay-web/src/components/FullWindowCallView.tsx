"use client";

import { useRef, useEffect, useMemo, useState, useCallback } from "react";
import { useCall } from "@/context/CallContext";
import { useIdentity } from "@/context/IdentityContext";
import { getParticipantSources, type ParticipantSource } from "@/lib/callUtils";
import { AbsentMembers } from "@/components/AbsentMembers";

const VOLUME_MIN = 0;
const VOLUME_MAX = 100;

/** Default aspect ratio: camera 16:9, screen 16:9 until video reports size. */
function getDefaultAspectRatio(sourceKey: string): number {
  return 16 / 9; // camera and screen; screen will update from video when loaded
}

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
  const [aspectRatio, setAspectRatio] = useState<number>(() => getDefaultAspectRatio(sourceKey));
  const gain = typeof volume === "number" ? Math.min(1, volume / 100) : 1;
  const hasVideo = !!stream?.getVideoTracks().length;

  useEffect(() => {
    if (stream && videoRef.current) videoRef.current.srcObject = stream;
    return () => {
      if (videoRef.current) videoRef.current.srcObject = null;
    };
  }, [stream]);
  useEffect(() => {
    if (videoRef.current && hasVideo && !isLocal) videoRef.current.volume = gain;
  }, [gain, isLocal, hasVideo]);
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

  const onVideoLoadedMetadata = useCallback(() => {
    const v = videoRef.current;
    if (v && v.videoWidth && v.videoHeight) setAspectRatio(v.videoWidth / v.videoHeight);
  }, []);

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

const DEFAULT_TILE_WIDTH = 360;
const DEFAULT_TILE_HEIGHT = 202; // 16:9
const MIN_TILE_WIDTH = 160;
const MIN_TILE_HEIGHT = 90;

type TileLayout = { x: number; y: number; width: number; height: number };

/**
 * Full-window call overlay. One tile per video source; tiles are draggable and resizable.
 */
export function FullWindowCallView() {
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
    hangUp,
  } = useCall();
  const { getDisplayName, getMyDisplayName, getContactVolume, setContactVolume } = useIdentity();
  const [volumeMenu, setVolumeMenu] = useState<{ keyHash: string; x: number; y: number } | null>(null);
  const volumeMenuRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [tileLayouts, setTileLayouts] = useState<Record<string, TileLayout>>({});
  const dragRef = useRef<{ key: string; startX: number; startY: number; startLeft: number; startTop: number } | null>(null);
  const resizeRef = useRef<{ key: string; startX: number; startY: number; startW: number; startH: number; startLeft: number; startTop: number } | null>(null);

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
    let name = isLocal ? getMyDisplayName() : (keyHash && getDisplayName(keyHash)) || participantId.slice(0, 8) + "…";
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

  const tileKeys = useMemo(() => tiles.map((t) => t.key), [tiles]);
  useEffect(() => {
    setTileLayouts((prev) => {
      let next = prev;
      tileKeys.forEach((key, i) => {
        if (next[key]) return;
        const row = Math.floor(i / 3);
        const col = i % 3;
        next = {
          ...next,
          [key]: {
            x: 12 + col * (DEFAULT_TILE_WIDTH + 12),
            y: 12 + row * (DEFAULT_TILE_HEIGHT + 12),
            width: DEFAULT_TILE_WIDTH,
            height: DEFAULT_TILE_HEIGHT,
          },
        };
      });
      return next;
    });
  }, [tileKeys.join(",")]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (dragRef.current) {
        const { key, startX, startY, startLeft, startTop } = dragRef.current;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        setTileLayouts((prev) => {
          const cur = prev[key];
          if (!cur) return prev;
          return { ...prev, [key]: { ...cur, x: startLeft + dx, y: startTop + dy } };
        });
      } else if (resizeRef.current) {
        const { key, startX, startY, startW, startH, startLeft, startTop } = resizeRef.current;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        setTileLayouts((prev) => {
          const cur = prev[key];
          if (!cur) return prev;
          const w = Math.max(MIN_TILE_WIDTH, startW + dx);
          const h = Math.max(MIN_TILE_HEIGHT, startH + dy);
          return { ...prev, [key]: { ...cur, width: w, height: h, x: startLeft, y: startTop } };
        });
      }
    };
    const onUp = () => {
      dragRef.current = null;
      resizeRef.current = null;
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
  }, []);

  return (
    <div className="fixed inset-0 z-50 bg-[var(--bg)] flex flex-col">
      <div className="flex items-center justify-between p-2 border-b border-[var(--border)]">
        <span className="text-sm text-[var(--muted)]">In call (full screen)</span>
        <button
          type="button"
          onClick={() => setCallExpanded(false)}
          className="px-3 py-1.5 rounded text-sm bg-[var(--border)] text-[var(--text)]"
        >
          Back to chat
        </button>
      </div>
      <div ref={containerRef} className="flex-1 min-h-0 p-2 overflow-hidden relative">
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
        {tiles.map((tile) => {
          const layout = tileLayouts[tile.key] ?? {
            x: 12,
            y: 12,
            width: DEFAULT_TILE_WIDTH,
            height: DEFAULT_TILE_HEIGHT,
          };
          const keyHash = tile.participantId === "local" ? undefined : peerKeyHashes.get(tile.participantId);
          const volume = keyHash != null ? getContactVolume(keyHash) : undefined;
          return (
            <div
              key={tile.key}
              className="absolute rounded-lg overflow-hidden bg-[var(--surface)] border border-[var(--border)] flex flex-col shadow-lg"
              style={{
                left: layout.x,
                top: layout.y,
                width: layout.width,
                height: layout.height,
              }}
            >
              <div
                className="flex-1 min-h-0 flex flex-col cursor-move select-none"
                onMouseDown={(e) => {
                  if ((e.target as HTMLElement).closest("[data-resize-handle]")) return;
                  e.preventDefault();
                  dragRef.current = {
                    key: tile.key,
                    startX: e.clientX,
                    startY: e.clientY,
                    startLeft: layout.x,
                    startTop: layout.y,
                  };
                }}
              >
                <ParticipantTile
                  sourceKey={tile.key}
                  participantId={tile.participantId}
                  isLocal={tile.isLocal}
                  stream={tile.stream}
                  displayLetter={tile.displayLetter}
                  displayName={tile.displayName}
                  speaking={speaking.has(tile.participantId)}
                  focused={focusedPeerId === tile.participantId}
                  onClick={() => setFocusedPeerId(tile.participantId === focusedPeerId ? null : tile.participantId)}
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
              </div>
              <div
                data-resize-handle
                className="absolute bottom-0 right-0 w-4 h-4 cursor-se-resize bg-[var(--border)]/80 hover:bg-[var(--muted)] rounded-tl"
                onMouseDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  resizeRef.current = {
                    key: tile.key,
                    startX: e.clientX,
                    startY: e.clientY,
                    startW: layout.width,
                    startH: layout.height,
                    startLeft: layout.x,
                    startTop: layout.y,
                  };
                }}
              />
            </div>
          );
        })}
        <div className="absolute left-3 bottom-20 z-10">
          <AbsentMembers />
        </div>
      </div>
      <div className="p-2 border-t border-[var(--border)] flex justify-start">
        <button type="button" onClick={() => hangUp()} className="px-4 py-2 rounded text-sm font-medium bg-red-600/80 text-white">
          Hang up
        </button>
      </div>
    </div>
  );
}
