"use client";

import { applyAudioRoute, resetAudioRoute } from "@/lib/audioRoute";
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import { useSpeakingDetection } from "@/lib/useSpeakingDetection";
import { getIceServers } from "@/lib/api";
import { createSocket } from "@/lib/socket";
import { secureSignalSocket } from "@/lib/callSignal";
import { useIdentity } from "@/context/IdentityContext";

/** Fallback when the relay has no TURN configured (or the request fails). STUN only works on friendly NATs. */
const FALLBACK_ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

export type ConversationForCall = { type: "dm"; otherKeyHash: string } | { type: "group"; memberKeyHashes: string[] };

type CallState = {
  socket: Socket | null;
  roomId: string;
  inCall: boolean;
  localStream: MediaStream | null;
  remoteStreams: Map<string, MediaStream>;
  peers: Set<string>;
  /** Peer socket id -> their keyHash (for display name / initial). */
  peerKeyHashes: Map<string, string>;
  muted: boolean;
  deafened: boolean;
  cameraOn: boolean;
  screenSharing: boolean;
  currentCallConversation: ConversationForCall | null;
  /** Who is currently speaking (audio above threshold). */
  speaking: Set<string>;
  /** Who last spoke; only updates when they stop and someone else is speaking. */
  lastSpokeId: string | null;
  /** Compact tile clicked = call takes full window. */
  callExpanded: boolean;
  /** In full-window view, which peer is focused (large). */
  focusedPeerId: string | null;
  /** Peer socket id -> { muted, deafened } from signaling. */
  peerMutedDeafened: Map<string, { muted: boolean; deafened: boolean }>;
  /** Refs used by UI to build one tile per video source (camera + screen). */
  cameraTrackRef: React.MutableRefObject<MediaStreamTrack | null>;
  screenTrackRef: React.MutableRefObject<MediaStreamTrack | null>;
  /** Set when server rejects join (room authorization). */
  roomJoinError: string | null;
  /** Rings a member who isn't in the call (registered by the chat page, which can send pushes); null if unavailable. */
  notifyMember: ((keyHash: string) => Promise<void>) | null;
};

type CallContextValue = CallState & {
  setRoomId: (id: string) => void;
  setCurrentCallConversation: (c: ConversationForCall | null) => void;
  startOrJoinCall: (
    roomId: string,
    keyHash?: string,
    allowedKeyHashes?: string[],
    onFirstInRoom?: () => void | Promise<void>
  ) => Promise<void>;
  dismissRoomJoinError: () => void;
  /** Returns true if we were the last to leave (room empty after we left). */
  hangUp: (roomId?: string) => Promise<boolean>;
  setMuted: (m: boolean) => void;
  setDeafened: (d: boolean) => void;
  setCameraOn: (on: boolean) => void;
  setScreenSharing: (on: boolean) => void;
  setCallExpanded: (v: boolean) => void;
  setFocusedPeerId: (id: string | null) => void;
  setNotifyMember: (fn: ((keyHash: string) => Promise<void>) | null) => void;
};

const CallContext = createContext<CallContextValue | null>(null);

export function CallProvider({ children }: { children: React.ReactNode }) {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [roomId, setRoomIdState] = useState("");
  const [inCall, setInCall] = useState(false);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStreams, setRemoteStreams] = useState<Map<string, MediaStream>>(new Map());
  const [peers, setPeers] = useState<Set<string>>(new Set());
  const [muted, setMuted] = useState(false);
  const [deafened, setDeafened] = useState(false);
  const [cameraOn, setCameraOn] = useState(false);
  const [screenSharing, setScreenSharing] = useState(false);
  const [currentCallConversation, setCurrentCallConversation] = useState<ConversationForCall | null>(null);
  const screenTrackRef = useRef<MediaStreamTrack | null>(null);
  const cameraTrackRef = useRef<MediaStreamTrack | null>(null);
  const [peerKeyHashes, setPeerKeyHashes] = useState<Map<string, string>>(new Map());
  const [callExpanded, setCallExpanded] = useState(false);
  const [focusedPeerId, setFocusedPeerId] = useState<string | null>(null);
  const [peerMutedDeafened, setPeerMutedDeafened] = useState<Map<string, { muted: boolean; deafened: boolean }>>(new Map());
  const [roomJoinError, setRoomJoinError] = useState<string | null>(null);
  const [notifyMember, setNotifyMemberState] = useState<((keyHash: string) => Promise<void>) | null>(null);
  // A function in state needs the updater form, or React would call it.
  const setNotifyMember = useCallback((fn: ((keyHash: string) => Promise<void>) | null) => setNotifyMemberState(() => fn), []);
  const pcRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const iceQueueRef = useRef<Map<string, RTCIceCandidateInit[]>>(new Map());
  const localStreamRef = useRef<MediaStream | null>(null);
  /** Fetched per call: TURN credentials are short-lived. */
  const iceServersRef = useRef<RTCIceServer[]>(FALLBACK_ICE_SERVERS);
  const roomIdRef = useRef(roomId);
  const socketRef = useRef(socket);
  const onFirstInRoomRef = useRef<(() => void | Promise<void>) | null>(null);
  const mutedRef = useRef(muted);
  const deafenedRef = useRef(deafened);
  roomIdRef.current = roomId;
  socketRef.current = socket;
  localStreamRef.current = localStream;
  mutedRef.current = muted;
  deafenedRef.current = deafened;

  const inCallRef = useRef(inCall);
  inCallRef.current = inCall;
  /** The socket id we're in the room as: a reconnect gets a new id, which must join again (see the "connect" effect). */
  const joinedAsRef = useRef<string | null>(null);
  /** Peer socket id -> the device behind it, so a device that reconnected under a new id replaces its old tile. */
  const peerDevicesRef = useRef<Map<string, string>>(new Map());
  const restartTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const { speaking, lastSpokeId } = useSpeakingDetection(localStream, remoteStreams, muted);

  /**
   * A peer connection with our handlers: remote tracks into remoteStreams, ICE candidates out, and recovery. When
   * the media path breaks (a phone moving between Wi-Fi and cellular, a NAT rebinding) the connection goes
   * "disconnected", then "failed"; one side (the lower socket id, so the two don't offer at once) replaces it with a
   * fresh connection and offer, and the other side answers that as usual.
   */
  const newPeer = useCallback(function make(peerId: string, sock: Socket): RTCPeerConnection {
    const pc = new RTCPeerConnection({ iceServers: iceServersRef.current });
    pcRef.current.set(peerId, pc);
    pc.ontrack = (e) => {
      if (!e.track) return;
      const track = e.track;
      const removeTrack = () => {
        setRemoteStreams((m) => {
          const prev = m.get(peerId);
          if (!prev) return m;
          const remaining = prev.getTracks().filter((t) => t !== track);
          const next = new Map(m);
          next.set(peerId, new MediaStream(remaining));
          return next;
        });
      };
      track.onended = removeTrack;
      setRemoteStreams((m) => {
        const next = new Map(m);
        const prev = next.get(peerId);
        next.set(peerId, new MediaStream(prev ? [...prev.getTracks(), track] : [track]));
        return next;
      });
    };
    pc.onicecandidate = (e) => {
      if (e.candidate) sock.emit("signal", { to: peerId, candidate: e.candidate.toJSON() });
    };
    const restart = async () => {
      const stream = localStreamRef.current;
      if (pcRef.current.get(peerId) !== pc || !stream || !sock.connected || !sock.id || sock.id > peerId) return;
      pc.close();
      iceQueueRef.current.delete(peerId);
      setRemoteStreams((m) => {
        const next = new Map(m);
        next.delete(peerId);
        return next;
      });
      const fresh = make(peerId, sock);
      stream.getTracks().forEach((t) => fresh.addTrack(t, stream));
      const offer = await fresh.createOffer();
      await fresh.setLocalDescription(offer);
      sock.emit("signal", { to: peerId, type: "offer", sdp: offer });
    };
    pc.onconnectionstatechange = () => {
      const timers = restartTimersRef.current;
      clearTimeout(timers.get(peerId));
      timers.delete(peerId);
      if (pc.connectionState === "failed") restart().catch(() => {});
      // "disconnected" often recovers by itself within a few seconds; if it doesn't, don't wait for "failed".
      else if (pc.connectionState === "disconnected") {
        timers.set(peerId, setTimeout(() => {
          timers.delete(peerId);
          if (pc.connectionState !== "connected") restart().catch(() => {});
        }, 5000));
      }
    };
    return pc;
  }, []);

  /** Forget a peer: its connection, tile and state. */
  const dropPeer = useCallback((id: string) => {
    setPeers((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    setPeerKeyHashes((prev) => {
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
    setPeerMutedDeafened((prev) => {
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
    pcRef.current.get(id)?.close();
    pcRef.current.delete(id);
    iceQueueRef.current.delete(id);
    peerDevicesRef.current.delete(id);
    clearTimeout(restartTimersRef.current.get(id));
    restartTimersRef.current.delete(id);
    setRemoteStreams((m) => {
      const next = new Map(m);
      next.delete(id);
      return next;
    });
  }, []);

  /** Drop every connection (hang up, or our socket came back under a new id). */
  const dropAllPeers = useCallback(() => {
    pcRef.current.forEach((pc) => pc.close());
    pcRef.current.clear();
    iceQueueRef.current.clear();
    peerDevicesRef.current.clear();
    restartTimersRef.current.forEach((t) => clearTimeout(t));
    restartTimersRef.current.clear();
    setRemoteStreams(new Map());
    setPeers(new Set());
    setPeerKeyHashes(new Map());
    setPeerMutedDeafened(new Map());
  }, []);

  /**
   * After join_room, offer to everyone already in the room. Delayed so: (1) the existing user's offer often arrives
   * first so we become the answerer (replaceTrack path works), and (2) our audio track is fully "live" before we add
   * it to the PC (same pattern as camera on: add track then offer after connection exists).
   */
  const offerToMembers = useCallback(
    (sock: Socket, members: Array<{ id: string; keyHash: string | null }> | string[]) => {
      const list =
        Array.isArray(members) && members.length > 0 && typeof members[0] === "object" && "id" in members[0]
          ? (members as Array<{ id: string }>)
          : (members as string[]).map((id) => ({ id }));
      // Only the first list after joining decides whether we started the call; a later rejoin never announces one.
      const cb = onFirstInRoomRef.current;
      onFirstInRoomRef.current = null;
      if (list.length === 0 && cb) Promise.resolve(cb()).catch(() => {});
      const offer = async (toId: string) => {
        const stream = localStreamRef.current;
        if (pcRef.current.has(toId) || !stream) return;
        const pc = newPeer(toId, sock);
        stream.getTracks().forEach((t) => pc.addTrack(t, stream));
        const o = await pc.createOffer();
        await pc.setLocalDescription(o);
        sock.emit("signal", { to: toId, type: "offer", sdp: o });
      };
      const JOIN_OFFER_DELAY_MS = 450;
      list.forEach(({ id }) => {
        if (id !== sock.id) setTimeout(() => offer(id).catch(() => {}), JOIN_OFFER_DELAY_MS);
      });
    },
    [newPeer]
  );

  const setRoomId = useCallback((id: string) => setRoomIdState(id), []);

  // The socket logs in as us, so it only exists once we're an enrolled member of a chosen server.
  const { enrolled, server, identity, refreshDirectory } = useIdentity();
  const myKeyHash = identity?.keyHash;
  // Signals are sealed per peer (callSignal.ts); these refs give the wrapper the latest identity and call members.
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const allowedRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!enrolled || !server || !myKeyHash) return;
    const s = createSocket();
    setSocket(
      secureSignalSocket(s, {
        me: () => {
          const id = identityRef.current;
          return id ? { keyPair: id.keyPair, keyHash: id.deviceKeyHash } : null;
        },
        // Any current device of a current member (mine included, for a call between my own devices).
        publicKeyFor: (device) => {
          const id = identityRef.current;
          if (!id) return undefined;
          if (device === id.deviceKeyHash) return id.publicKeyBase64;
          return (
            id.myDevices.find((d) => d.keyHash === device)?.ecdh ??
            id.contacts.flatMap((c) => c.devices).find((d) => d.keyHash === device)?.publicKey
          );
        },
        allowed: () => allowedRef.current,
        room: () => roomIdRef.current,
      })
    );
    return () => {
      s.close();
      setSocket(null);
    };
  }, [enrolled, server, myKeyHash]);

  // The server says the member list, a device or a sealed name changed: refresh now rather than at the next poll, so
  // a new member or device sees everyone's names (and everyone sees theirs) within seconds.
  useEffect(() => {
    if (!socket) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onDirectory = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        refreshDirectory().catch(() => {});
      }, 300);
    };
    socket.on("directory", onDirectory);
    return () => {
      if (timer) clearTimeout(timer);
      socket.off("directory", onDirectory);
    };
  }, [socket, refreshDirectory]);

  const drainIceQueue = useCallback(async (pc: RTCPeerConnection, peerId: string) => {
    const queue = iceQueueRef.current.get(peerId);
    if (!queue) return;
    iceQueueRef.current.delete(peerId);
    for (const c of queue) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(c));
      } catch {
        // ignore
      }
    }
  }, []);

  useEffect(() => {
    if (!localStream) return;
    localStream.getAudioTracks().forEach((t) => {
      t.enabled = !muted;
    });
  }, [localStream, muted]);

  // Only mute the camera track when camera is "off"; screen track stays enabled when present
  useEffect(() => {
    if (!localStream) return;
    const cam = cameraTrackRef.current;
    localStream.getVideoTracks().forEach((t) => {
      t.enabled = t === cam ? cameraOn : true;
    });
  }, [localStream, cameraOn]);

  useEffect(() => {
    if (!socket) return;
    socket.on("members", (members: Array<{ id: string; keyHash: string | null }> | string[]) => {
      const list = Array.isArray(members) && members.length > 0 && typeof members[0] === "object" && "id" in members[0]
        ? (members as Array<{ id: string; keyHash: string | null }>)
        : (members as string[]).map((id) => ({ id, keyHash: null }));
      setPeers((prev) => {
        const next = new Set(prev);
        list.forEach((m) => next.add(m.id));
        return next;
      });
      setPeerKeyHashes((prev) => {
        const next = new Map(prev);
        list.forEach((m) => {
          if (m.keyHash) next.set(m.id, m.keyHash);
        });
        return next;
      });
      list.forEach((m) => {
        const device = (m as { device?: string | null }).device;
        if (device) peerDevicesRef.current.set(m.id, device);
      });
      // Announcing a call we started is offerToMembers' job (it runs on the same "members" list).
    });
    socket.on("peer_joined", (payload: { id: string; keyHash: string | null; device?: string | null } | string) => {
      const id = typeof payload === "string" ? payload : payload.id;
      const keyHash = typeof payload === "object" ? payload.keyHash : null;
      const device = typeof payload === "object" ? payload.device : null;
      // The same device under a new socket id reconnected (e.g. changed networks): its old connection is dead, even if
      // the server hasn't noticed yet.
      if (device) {
        for (const [oldId, d] of peerDevicesRef.current) if (d === device && oldId !== id) dropPeer(oldId);
        peerDevicesRef.current.set(id, device);
      }
      setPeers((prev) => new Set(prev).add(id));
      if (keyHash) setPeerKeyHashes((prev) => new Map(prev).set(id, keyHash));
      // So the new joiner sees our mute/deafen state: re-send our state when someone joins.
      const rid = roomIdRef.current;
      if (rid) {
        socket.emit("call_state", rid, { muted: mutedRef.current, deafened: deafenedRef.current });
      }
    });
    socket.on("peer_left", (id: string) => dropPeer(id));
    socket.on("peer_call_state", (payload: { id: string; muted: boolean; deafened: boolean }) => {
      const { id: peerId, muted: m, deafened: d } = payload;
      if (!peerId) return;
      setPeerMutedDeafened((prev) => new Map(prev).set(peerId, { muted: m, deafened: d }));
    });
    socket.on("room_join_error", (payload: { message?: string }) => {
      setRoomJoinError(payload?.message ?? "Not allowed to join this call.");
      localStreamRef.current?.getTracks().forEach((t) => t.stop());
      screenTrackRef.current?.stop();
      screenTrackRef.current = null;
      setLocalStream(null);
      setInCall(false);
      joinedAsRef.current = null;
      dropAllPeers();
    });
    return () => {
      socket.off("members");
      socket.off("peer_joined");
      socket.off("peer_left");
      socket.off("peer_call_state");
      socket.off("room_join_error");
    };
  }, [socket, dropPeer, dropAllPeers]);

  // Our socket came back under a new id (the network changed, or the server restarted): the server no longer has us
  // in the room and every peer connection was set up through the old id. Join again as if new; the others drop our
  // old tile (peer_left, or our device rejoining) and connect to the new id.
  useEffect(() => {
    if (!socket) return;
    const onConnect = () => {
      const rid = roomIdRef.current;
      const allowed = allowedRef.current;
      if (!inCallRef.current || !rid || !allowed || !localStreamRef.current || socket.id === joinedAsRef.current) return;
      dropAllPeers();
      onFirstInRoomRef.current = null;
      joinedAsRef.current = socket.id ?? null;
      socket.once("members", (members: Array<{ id: string; keyHash: string | null }> | string[]) => offerToMembers(socket, members));
      socket.emit("join_room", rid, null, [...allowed]);
      socket.emit("call_state", rid, { muted: mutedRef.current, deafened: deafenedRef.current });
    };
    socket.on("connect", onConnect);
    return () => {
      socket.off("connect", onConnect);
    };
  }, [socket, dropAllPeers, offerToMembers]);

  const startOrJoinCall = useCallback(
    async (
      rid: string,
      keyHash?: string,
      allowedKeyHashes?: string[],
      onFirstInRoom?: () => void | Promise<void>
    ) => {
      if (!socket || !rid.trim()) return;
      setRoomJoinError(null);
      onFirstInRoomRef.current = onFirstInRoom ?? null;
      const allowed = Array.isArray(allowedKeyHashes) && allowedKeyHashes.length > 0 ? allowedKeyHashes : [];
      if (allowed.length === 0) {
        setRoomJoinError("Cannot join call: conversation members unknown.");
        return;
      }
      // Only this conversation's members can exchange (sealed) signals with us in this call.
      allowedRef.current = new Set(allowed);
      const fetched = await getIceServers().catch(() => []);
      iceServersRef.current = fetched.length > 0 ? fetched : FALLBACK_ICE_SERVERS;
      // Audio only at join; video is requested only when user turns camera on
      // Earpiece or loudspeaker, as chosen (audioRoute.ts): set before the microphone opens.
      applyAudioRoute();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      // And again once it's open: opening it can set the route back (a call started on the speaker otherwise).
      applyAudioRoute();
      setLocalStream(stream);
      localStreamRef.current = stream;
      setCameraOn(false);
      setMuted(false);
      setDeafened(false);
      setInCall(true);
      setRoomIdState(rid.trim());
      roomIdRef.current = rid.trim();
      // A new call opens on the call screen; back to the chat from there.
      setCallExpanded(true);
      setFocusedPeerId(null);

      // Register for "members" before emitting join_room so we never miss the list (avoids race where
      // server sends "members" before the effect that subscribes runs, which could break audio-only setup).
      const onMembers = (members: Array<{ id: string; keyHash: string | null }> | string[]) => offerToMembers(socket, members);
      socket.once("members", onMembers);
      joinedAsRef.current = socket.id ?? null;
      socket.emit("join_room", rid.trim(), keyHash ?? null, allowed);
    },
    [socket, offerToMembers]
  );

  const dismissRoomJoinError = useCallback(() => setRoomJoinError(null), []);

  const hangUp = useCallback(
    (rid?: string): Promise<boolean> => {
      const roomToLeave = rid ?? roomIdRef.current;
      const stream = localStreamRef.current;

      const clearCallState = () => {
        joinedAsRef.current = null;
        dropAllPeers();
        stream?.getTracks().forEach((t) => t.stop());
        screenTrackRef.current?.stop();
        screenTrackRef.current = null;
        setLocalStream(null);
        setInCall(false);
        setMuted(false);
        setDeafened(false);
        setCameraOn(false);
        setScreenSharing(false);
        setCallExpanded(false);
        setFocusedPeerId(null);
        setCurrentCallConversation(null);
        resetAudioRoute();
      };

      clearCallState();
      if (!roomToLeave || !socket) return Promise.resolve(false);

      return new Promise<boolean>((resolve) => {
        const timeout = setTimeout(() => {
          socket.off("last_to_leave", onLast);
          resolve(false);
        }, 2000);
        const onLast = () => {
          clearTimeout(timeout);
          socket.off("last_to_leave", onLast);
          resolve(true);
        };
        socket.once("last_to_leave", onLast);
        socket.emit("leave_room", roomToLeave);
      });
    },
    [socket, dropAllPeers]
  );

  // A call belongs to one server: switching servers ends it.
  const serverUrl = server?.url;
  const callServerRef = useRef(serverUrl);
  useEffect(() => {
    if (callServerRef.current !== serverUrl && inCall) hangUp();
    callServerRef.current = serverUrl;
  }, [serverUrl, inCall, hangUp]);

  const setScreenSharingWithMedia = useCallback(async (on: boolean) => {
    const stream = localStreamRef.current;
    const sock = socketRef.current;
    if (on) {
      if (!stream || !sock) return;
      try {
        const screenStream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: false,
        });
        const screenTrack = screenStream.getVideoTracks()[0];
        if (!screenTrack) {
          screenStream.getTracks().forEach((t) => t.stop());
          return;
        }
        screenTrack.onended = () => setScreenSharingWithMedia(false);
        screenTrack.enabled = true;
        screenTrackRef.current = screenTrack;
        stream.addTrack(screenTrack);
        const newStream = new MediaStream(stream.getTracks());
        setLocalStream(newStream);
        localStreamRef.current = newStream;
        for (const [, pc] of pcRef.current) {
          pc.addTrack(screenTrack, newStream);
        }
        setScreenSharing(true);
        for (const [peerId, pc] of pcRef.current) {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          sock.emit("signal", { to: peerId, type: "offer", sdp: offer });
        }
      } catch (err) {
        screenTrackRef.current = null;
      }
    } else {
      const track = screenTrackRef.current;
      screenTrackRef.current = null;
      const str = localStreamRef.current;
      if (track && str && sock) {
        str.removeTrack(track);
        track.onended = null;
        track.stop();
        for (const [, pc] of pcRef.current) {
          const transceivers = pc.getTransceivers?.() ?? [];
          const screenTransceiver = transceivers.find((t) => t.sender?.track === track);
          if (screenTransceiver) screenTransceiver.stop();
        }
        const newStream = new MediaStream(str.getTracks());
        setLocalStream(newStream);
        localStreamRef.current = newStream;
        for (const [peerId, pc] of pcRef.current) {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          sock.emit("signal", { to: peerId, type: "offer", sdp: offer });
        }
      }
      setScreenSharing(false);
    }
  }, []);

  const setCameraOnWithMedia = useCallback(async (on: boolean) => {
    const stream = localStreamRef.current;
    const sock = socketRef.current;
    if (on) {
      if (!stream || !sock) return;
      try {
        const videoStream = await navigator.mediaDevices.getUserMedia({ video: true });
        const videoTrack = videoStream.getVideoTracks()[0];
        if (!videoTrack) {
          videoStream.getTracks().forEach((t) => t.stop());
          return;
        }
        cameraTrackRef.current = videoTrack;
        stream.addTrack(videoTrack);
        const newStream = new MediaStream(stream.getTracks());
        setLocalStream(newStream);
        localStreamRef.current = newStream;
        setCameraOn(true);
        for (const [peerId, pc] of pcRef.current) {
          pc.addTrack(videoTrack, newStream);
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          sock.emit("signal", { to: peerId, type: "offer", sdp: offer });
        }
      } catch {
        // e.g. permission denied
      }
    } else {
      const cam = cameraTrackRef.current;
      cameraTrackRef.current = null;
      if (!stream || !sock || !cam) return;
      stream.removeTrack(cam);
      cam.stop();
      pcRef.current.forEach((pc) => {
        const transceivers = pc.getTransceivers?.() ?? [];
        const transceiver = transceivers.find((t) => t.sender?.track === cam);
        if (transceiver) transceiver.stop();
      });
      const newStream = new MediaStream(stream.getTracks());
      setLocalStream(newStream);
      localStreamRef.current = newStream;
      setCameraOn(false);
      for (const [peerId, pc] of pcRef.current) {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        sock.emit("signal", { to: peerId, type: "offer", sdp: offer });
      }
    }
  }, []);

  const signalHandler = useCallback(
    (localStream: MediaStream | null, socket: Socket | null) => {
      if (!socket) return () => {};
      const handleSignal = async (payload: {
        from: string;
        type?: string;
        sdp?: RTCSessionDescriptionInit;
        candidate?: RTCIceCandidateInit;
      }) => {
        const from = payload.from;
        let pc = pcRef.current.get(from);
        if (payload.sdp?.type === "offer") {
          if (pc) {
            pc.close();
            pcRef.current.delete(from);
            iceQueueRef.current.delete(from);
            pc = undefined;
          }
          const streamToUse = localStreamRef.current ?? localStream;
          if (!pc && streamToUse) {
            pc = newPeer(from, socket);
            try {
              await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              if (!msg.includes("m-lines") && !msg.includes("order") && !msg.includes("SSL role")) throw err;
              return;
            }
            await drainIceQueue(pc, from);
            // Use the offer's transceivers and add our send track so the answer has one m-line and we receive remote audio.
            // (Fixes existing participant not hearing new joiner until joiner turns on camera.)
            const transceivers = pc.getTransceivers?.() ?? [];
            const audioTracks = streamToUse.getAudioTracks();
            const videoTracks = streamToUse.getVideoTracks();
            let audioIdx = 0;
            let videoIdx = 0;
            for (const tr of transceivers) {
              const kind = tr.receiver.track?.kind ?? tr.sender.track?.kind;
              if (kind === "audio" && audioIdx < audioTracks.length) {
                tr.direction = "sendrecv";
                tr.sender.replaceTrack(audioTracks[audioIdx]);
                audioIdx++;
              } else if (kind === "video" && videoIdx < videoTracks.length) {
                tr.direction = "sendrecv";
                tr.sender.replaceTrack(videoTracks[videoIdx]);
                videoIdx++;
              }
            }
            // If offer had no matching transceiver for our track (shouldn't happen), add track so we at least send.
            if (audioIdx === 0 && audioTracks.length > 0) {
              streamToUse.getTracks().forEach((t) => pc!.addTrack(t, streamToUse));
            }
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            socket.emit("signal", { to: from, type: "answer", sdp: answer });
          }
        } else if (payload.sdp?.type === "answer" && pc && pc.signalingState === "have-local-offer") {
          try {
            await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
            await drainIceQueue(pc, from);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (!msg.includes("m-lines") && !msg.includes("order") && !msg.includes("SSL role")) throw err;
          }
        } else if (payload.candidate) {
          if (pc) {
            if (pc.remoteDescription) {
              try {
                await pc.addIceCandidate(new RTCIceCandidate(payload.candidate));
              } catch {
                // ignore
              }
            } else {
              const q = iceQueueRef.current.get(from) ?? [];
              q.push(payload.candidate);
              iceQueueRef.current.set(from, q);
            }
          }
        }
      };
      socket.on("signal", handleSignal);
      return () => socket.off("signal", handleSignal);
    },
    [drainIceQueue, newPeer]
  );

  useEffect(() => {
    return signalHandler(localStream, socket);
  }, [socket, localStream, signalHandler]);

  useEffect(() => {
    if (inCall && roomIdRef.current && socket) {
      socket.emit("call_state", roomIdRef.current, { muted, deafened });
    }
  }, [inCall, socket, muted, deafened]);

  // When someone joins after us, create an offer to them. ("members" is handled in startOrJoinCall before emit.)
  useEffect(() => {
    if (!inCall || !localStream || !socket) return;
    const createOfferTo = async (toId: string) => {
      if (pcRef.current.has(toId)) return;
      const pc = newPeer(toId, socket);
      localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit("signal", { to: toId, type: "offer", sdp: offer });
    };
    const onPeerJoined = (payload: { id: string; keyHash?: string | null } | string) => {
      const id = typeof payload === "string" ? payload : payload?.id;
      if (id && id !== socket.id) {
        setTimeout(() => createOfferTo(id), 80);
      }
    };
    socket.on("peer_joined", onPeerJoined);
    return () => {
      socket.off("peer_joined", onPeerJoined);
    };
  }, [inCall, localStream, socket, newPeer]);

  const value = useMemo<CallContextValue>(
    () => ({
      socket,
      roomId,
      inCall,
      localStream,
      remoteStreams,
      peers,
      peerKeyHashes,
      muted,
      deafened,
      cameraOn,
      screenSharing,
      currentCallConversation,
      speaking,
      lastSpokeId: inCall ? lastSpokeId : null,
      callExpanded,
      focusedPeerId,
      peerMutedDeafened,
      cameraTrackRef,
      screenTrackRef,
      roomJoinError,
      setRoomId,
      setCurrentCallConversation,
      startOrJoinCall,
      notifyMember,
      setNotifyMember,
      hangUp,
      dismissRoomJoinError,
      setMuted,
      setDeafened,
      setCameraOn: setCameraOnWithMedia,
      setScreenSharing: setScreenSharingWithMedia,
      setCallExpanded,
      setFocusedPeerId,
    }),
    [
      socket,
      roomId,
      inCall,
      localStream,
      remoteStreams,
      peers,
      peerKeyHashes,
      muted,
      deafened,
      cameraOn,
      screenSharing,
      currentCallConversation,
      speaking,
      lastSpokeId,
      callExpanded,
      focusedPeerId,
      peerMutedDeafened,
      roomJoinError,
      setRoomId,
      setCurrentCallConversation,
      startOrJoinCall,
      notifyMember,
      setNotifyMember,
      hangUp,
      dismissRoomJoinError,
      setCameraOnWithMedia,
      setScreenSharingWithMedia,
      setCallExpanded,
      setFocusedPeerId,
    ]
  );

  return <CallContext.Provider value={value}>{children}</CallContext.Provider>;
}

export function useCall() {
  const ctx = useContext(CallContext);
  if (!ctx) throw new Error("useCall must be used within CallProvider");
  return ctx;
}
