"use client";

import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { useIdentity } from "@/context/IdentityContext";
import { useCall } from "@/context/CallContext";
import { CompactCallTile } from "@/components/CallTile";
import { InlineCallView } from "@/components/InlineCallView";
import { RemoteCallAudio } from "@/components/RemoteCallAudio";
import { CreateIdentity, JoinServer, NotEnrolled, UnlockIdentity } from "@/components/Onboarding";
import { TokenWarning } from "@/components/TokenWarning";
import { SettingsModal } from "@/components/SettingsModal";
import { InstallFirst, useInstallFirst } from "@/components/AppShell";
import { ServerSwitcher } from "@/components/ServerSwitcher";
import {
  useMessages,
  type Conversation,
  conversationId,
  messageBelongsToConversation,
} from "@/lib/useMessages";
import { activeCallRoom, newRoomId } from "@/lib/callRoom";
import type { DecryptedMessage } from "@/lib/blobPayload";
import { blobSettings } from "@/lib/signed";
import { activeMentionQuery, encodeDraft, mentionsMe, EVERYONE, type PickedMention } from "@/lib/mentions";
import { sendPushes } from "@/lib/push";
import { usePlugins } from "@/context/PluginContext";
import { PluginMessage } from "@/components/PluginMessage";
import { MentionPicker, MessageText, type MentionCandidate } from "@/components/Mentions";

const GROUP_BREAK_MS = 10 * 60 * 1000;

/**
 * Messages from the same sender with < 10 min gap from the previous message
 * are visually grouped (no header repeated).
 */
const iconProps = {
  width: 14,
  height: 14,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

function RetryIcon() {
  return (
    <svg {...iconProps}>
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3v6h-6" />
    </svg>
  );
}

function CancelIcon() {
  return (
    <svg {...iconProps}>
      <path d="M6 6l12 12" />
      <path d="M18 6L6 18" />
    </svg>
  );
}

function isGroupedWithPrev(
  msg: DecryptedMessage,
  prev: DecryptedMessage | undefined
): boolean {
  if (!prev) return false;
  if (msg.type === "call_event" || msg.type === "group_rename") return false;
  if (prev.type === "call_event" || prev.type === "group_rename") return false;
  if (msg.senderKeyHash !== prev.senderKeyHash) return false;
  return msg.sentAt - prev.sentAt < GROUP_BREAK_MS;
}

function formatMsgTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  if (isToday) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return (
    d.toLocaleDateString([], { month: "short", day: "numeric" }) +
    " " +
    d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  );
}

function conversationLabel(
  conv: Conversation,
  myKeyHash: string,
  getDisplayName: (k: string) => string | undefined,
  groupNames: Map<string, string>
): string {
  if (conv.type === "dm") {
    return getDisplayName(conv.otherKeyHash) || conv.otherKeyHash.slice(0, 8);
  }
  const n = conv.memberKeyHashes.length;
  const name = groupNames.get(conversationId(conv, myKeyHash)) || "Group Chat";
  return `${name} (${n})`;
}

// Inline styles for iOS safe area insets — keeps Tailwind classes static for JIT.
const safeTop: React.CSSProperties = {
  paddingTop: "calc(env(safe-area-inset-top, 0px) + 0.75rem)",
};
const safeBottom: React.CSSProperties = {
  paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 0.5rem)",
};

function getMimeType(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
    gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
    pdf: "application/pdf", txt: "text/plain",
    mp4: "video/mp4", mov: "video/quicktime",
    mp3: "audio/mpeg", wav: "audio/wav",
    zip: "application/zip", json: "application/json",
  };
  return map[ext] ?? "application/octet-stream";
}

/** Drop directory parts and leading dots: the filename comes from the sender and could be "../identity.bin". */
function safeFilename(name: string): string {
  const base = (name.split(/[\\/]/).pop() ?? "").replace(/^\.+/, "").trim();
  return base || "download";
}

/**
 * Save a file received as a base64 blob: an object URL clicked as a download (on iOS this opens the preview, where
 * Share saves it).
 */
async function downloadFile(base64Body: string, rawFilename: string): Promise<void> {
  const filename = safeFilename(rawFilename);
  const bin = Uint8Array.from(atob(base64Body), (c) => c.charCodeAt(0));
  const blob = new Blob([bin], { type: getMimeType(filename) });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename || "download";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Remounts the chat for each server, so no conversation or call state carries over when switching. */
export default function Home() {
  const { server } = useIdentity();
  return <Chat key={server?.url ?? ""} />;
}

function Chat() {
  const {
    identity, loading, needsSetup, lockedFile, enrolled, directory, directoryLoaded, error: identityError, server, cacheKey,
    applyDeviceSync, settingsChangedAt,
    getDisplayName, getMyDisplayName, setDisplayName, getMember, isRemoved,
  } = useIdentity();
  const {
    inCall, callExpanded, muted, deafened, cameraOn, screenSharing,
    currentCallConversation, setMuted, setDeafened, setCameraOn,
    setScreenSharing, hangUp, setCurrentCallConversation, setCallExpanded,
    startOrJoinCall, roomJoinError, dismissRoomJoinError, roomId: currentRoomId, setNotifyMember,
  } = useCall();
  // Messages need a login, which needs membership: nothing is fetched until we're enrolled on a server.
  // Wait for the cache key too, so the first sync resumes from the cached cursor instead of starting over.
  const { messages, conversations, sendMessage, sendHistory, retrySend, cancelSend, storage, readMarks, markRead, error } = useMessages(
    enrolled && server && cacheKey !== undefined ? identity : null,
    useMemo(() => blobSettings(directory), [directory]),
    cacheKey ?? null,
    applyDeviceSync
  );

  // My name or contact settings changed here (or a device was just linked): send them to my other devices.
  useEffect(() => {
    if (!settingsChangedAt || !identity || identity.myDevices.length < 2) return;
    sendMessage(
      {
        type: "device_sync",
        myName: identity.myName,
        contactSettings: identity.contactSettings,
        settingsAt: identity.settingsAt ?? settingsChangedAt,
      } as Omit<DecryptedMessage, "senderKeyHash" | "sentAt" | "messageId">,
      []
    );
    // Only on a change here, not whenever the identity object changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsChangedAt, identity?.myDevices.length]);

  const installFirst = useInstallFirst();
  const { runtime: plugins, setSendHandler } = usePlugins();
  const [selected, setSelected] = useState<Conversation | null>(null);
  // On mobile: controls whether the sidebar or the chat panel is visible.
  // On desktop (md+) both are always visible, so this is ignored.
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [input, setInput] = useState("");
  // Mentions picked in this draft (shown as "@name", sent as tokens), and the "@…" being typed, if any.
  const [picked, setPicked] = useState<PickedMention[]>([]);
  const [mentionQuery, setMentionQuery] = useState<{ start: number; query: string } | null>(null);
  const [mentionActive, setMentionActive] = useState(0);
  const composerRef = useRef<HTMLInputElement>(null);
  const [newGroupOpen, setNewGroupOpen] = useState(false);
  const [newGroupSelected, setNewGroupSelected] = useState<Set<string>>(new Set());
  const [displayNameModal, setDisplayNameModal] = useState<{ keyHash: string } | null>(null);
  const [displayNameValue, setDisplayNameValue] = useState("");
  const [displayNameSaveError, setDisplayNameSaveError] = useState<string | null>(null);
  const [displayNameSaving, setDisplayNameSaving] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [addingServer, setAddingServer] = useState(false);
  const [groupRenameModal, setGroupRenameModal] = useState<Conversation | null>(null);
  const [groupRenameValue, setGroupRenameValue] = useState("");
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const messagesListRef = useRef<HTMLUListElement>(null);
  const wasAtBottomRef = useRef(true);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressActivated = useRef(false);

  // Detect software keyboard on mobile via visualViewport resize.
  // When the keyboard is up the bottom safe-area padding is redundant (keyboard is the boundary).
  useEffect(() => {
    const vv = typeof window !== "undefined" ? window.visualViewport : null;
    if (!vv) return;
    const update = () => setKeyboardVisible(vv.height < window.innerHeight - 100);
    vv.addEventListener("resize", update);
    return () => vv.removeEventListener("resize", update);
  }, []);

  const endLongPress = useCallback(() => {
    if (longPressTimer.current !== null) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }, []);

  const readFileAsBase64 = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(((r.result as string).split(",")[1]) ?? "");
      r.onerror = () => reject(r.error);
      r.readAsDataURL(file);
    });

  const filteredMessages = useMemo(() => {
    if (!selected || !identity) return [];
    return messages.filter((m) => messageBelongsToConversation(m, selected, identity.keyHash));
  }, [messages, selected, identity?.keyHash]);

  /** The room of this conversation's ongoing call, if any (random, announced in the encrypted "started" message). */
  const ongoingRoom = useMemo(() => activeCallRoom(filteredMessages), [filteredMessages]);

  /** Display name for a member as this viewer knows them. */
  const nameFor = useCallback(
    (k: string) => (k === identity?.keyHash ? getMyDisplayName() : getDisplayName(k) || k.slice(0, 8)),
    [identity?.keyHash, getMyDisplayName, getDisplayName]
  );

  // "@…" suggestions: the conversation's other members by your names for them, and @everyone in groups.
  const mentionCandidates = useMemo<MentionCandidate[]>(() => {
    if (!mentionQuery || !selected || !identity) return [];
    const others = selected.type === "dm" ? [selected.otherKeyHash] : selected.memberKeyHashes.filter((k) => k !== identity.keyHash);
    const all: MentionCandidate[] = others.map((k) => ({ keyHash: k, label: nameFor(k) }));
    if (selected.type === "group") all.push({ keyHash: EVERYONE, label: EVERYONE });
    const q = mentionQuery.query.toLowerCase();
    return all.filter((c) => c.label.toLowerCase().includes(q)).slice(0, 8);
  }, [mentionQuery, selected, identity, nameFor]);

  const pickMention = (c: MentionCandidate) => {
    if (!mentionQuery) return;
    const el = composerRef.current;
    const caret = el?.selectionStart ?? input.length;
    const next = `${input.slice(0, mentionQuery.start)}@${c.label} ${input.slice(caret)}`;
    setInput(next);
    setPicked((p) => [...p.filter((x) => x.keyHash !== c.keyHash), { label: c.label, keyHash: c.keyHash }]);
    setMentionQuery(null);
    const pos = mentionQuery.start + c.label.length + 2;
    requestAnimationFrame(() => el?.setSelectionRange(pos, pos));
  };

  // Seeing a conversation (open, app in front) clears its mention badge up to its newest message.
  useEffect(() => {
    if (!selected) return;
    const mark = () => {
      if (document.visibilityState !== "visible") return;
      const newest = filteredMessages.reduce((n, m) => Math.max(n, m.sentAt), 0);
      if (newest) markRead(selected, newest);
    };
    mark();
    document.addEventListener("visibilitychange", mark);
    return () => document.removeEventListener("visibilitychange", mark);
  }, [selected, filteredMessages, markRead]);

  /** Unread mentions of me per conversation, for the sidebar badge. */
  const unreadMentions = useCallback(
    (conv: Conversation) => {
      if (!identity) return 0;
      const seen = readMarks[conversationId(conv, identity.keyHash)] ?? 0;
      return messages.filter((m) => m.sentAt > seen && mentionsMe(m, identity.keyHash) && messageBelongsToConversation(m, conv, identity.keyHash)).length;
    },
    [identity, readMarks, messages]
  );

  const groupNamesFromMessages = useMemo(() => {
    const map = new Map<string, string>();
    if (!identity) return map;
    for (const conv of conversations) {
      if (conv.type !== "group") continue;
      const cid = conversationId(conv, identity.keyHash);
      const renames = messages.filter(
        (m) => m.type === "group_rename" && messageBelongsToConversation(m, conv, identity.keyHash)
      );
      const last = [...renames].sort((a, b) => b.sentAt - a.sentAt)[0];
      if (last && last.type === "group_rename") map.set(cid, last.newName);
    }
    return map;
  }, [conversations, messages, identity?.keyHash]);

  const prevFilteredLengthRef = useRef(0);
  useEffect(() => {
    const list = messagesListRef.current;
    if (!list) return;
    if (filteredMessages.length > prevFilteredLengthRef.current && wasAtBottomRef.current) {
      requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; });
    }
    prevFilteredLengthRef.current = filteredMessages.length;
  }, [filteredMessages.length, filteredMessages]);

  const handleMessagesScroll = () => {
    const list = messagesListRef.current;
    if (!list) return;
    wasAtBottomRef.current = list.scrollHeight - list.clientHeight <= list.scrollTop + 80;
  };

  useEffect(() => { wasAtBottomRef.current = true; }, [selected]);

  useEffect(() => {
    const list = messagesListRef.current;
    if (list && selected) requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; });
  }, [selected]);

  const keyHashesWithDm = useMemo(() => {
    const set = new Set<string>();
    for (const c of conversations) { if (c.type === "dm") set.add(c.otherKeyHash); }
    return set;
  }, [conversations]);

  const contactsWithoutDmSorted = useMemo(() => {
    const list = identity?.contacts.filter(
      (c) => c.keyHash !== identity.keyHash && !keyHashesWithDm.has(c.keyHash)
    ) ?? [];
    return [...list].sort((a, b) => {
      const na = getDisplayName(a.keyHash) || a.keyHash;
      const nb = getDisplayName(b.keyHash) || b.keyHash;
      return na.localeCompare(nb, undefined, { numeric: true });
    });
  }, [identity?.contacts, keyHashesWithDm, getDisplayName]);

  /** Pushes for a message's mentions (DESIGN.md §9): each mentioned member's devices; @everyone, every member's. */
  const notifyMentions = async (mentions: string[], recipients: string[]) => {
    if (!identity || !selected) return;
    const everyone = mentions.includes(EVERYONE);
    const targets = everyone ? recipients : mentions.filter((k) => k !== EVERYONE && recipients.includes(k));
    const devices = targets.flatMap((k) => identity.contacts.find((c) => c.keyHash === k)?.devices ?? []);
    const group = selected.type === "group" ? groupNamesFromMessages.get(conversationId(selected, identity.keyHash)) : undefined;
    await sendPushes(everyone ? "everyone" : "mention", identity, devices, { member: identity.keyHash, group });
  };

  // The call's Notify button: ring one member's devices (rate-limited per person by the server).
  useEffect(() => {
    if (!identity) return setNotifyMember(null);
    setNotifyMember(async (k: string) => {
      const devices = identity.contacts.find((c) => c.keyHash === k)?.devices ?? [];
      const conv = currentCallConversation;
      const group =
        conv?.type === "group" ? groupNamesFromMessages.get(conversationId(conv, identity.keyHash)) ?? "a group call" : undefined;
      const r = await sendPushes("ring", identity, devices, { member: identity.keyHash, group });
      if (r.limited && !r.sent) throw new Error("Rung recently; try again shortly");
      if (!r.sent) throw new Error("They haven't turned on notifications");
    });
    return () => setNotifyMember(null);
  }, [identity, currentCallConversation, groupNamesFromMessages, setNotifyMember]);

  // A plugin asks to send one of its message types: to the open conversation, only if you say yes.
  useEffect(() => {
    setSendHandler((req) => {
      if (!identity || !selected) return;
      if (!window.confirm(`${req.plugin.name} wants to send in this conversation:\n\n"${req.fallback}"\n\nSend it?`)) return;
      const base = { type: "plugin", pluginType: req.messageType, data: req.data, fallback: req.fallback };
      if (selected.type === "dm") {
        sendMessage(base as Omit<DecryptedMessage, "senderKeyHash" | "sentAt" | "messageId">, [selected.otherKeyHash], {
          recipientKeyHash: selected.otherKeyHash,
        });
      } else {
        sendMessage(
          { ...base, groupMemberKeyHashes: selected.memberKeyHashes } as Omit<DecryptedMessage, "senderKeyHash" | "sentAt" | "messageId">,
          selected.memberKeyHashes.filter((k) => k !== identity.keyHash)
        );
      }
    });
    return () => setSendHandler(null);
  }, [identity, selected, sendMessage, setSendHandler]);

  // Plugins may read (not change) messages as they arrive in the open conversation.
  const lastToPlugins = useRef<string | null>(null);
  useEffect(() => {
    const last = filteredMessages[filteredMessages.length - 1];
    if (!plugins || !identity || !last || last.outbox || last.messageId === lastToPlugins.current) return;
    lastToPlugins.current = last.messageId;
    if (last.type !== "text" && last.type !== "plugin") return;
    plugins.notifyMessage({
      type: last.type === "plugin" ? last.pluginType : "text",
      body: last.type === "text" ? last.body : undefined,
      sender: nameFor(last.senderKeyHash),
      mine: last.senderKeyHash === identity.keyHash,
    });
  }, [filteredMessages, plugins, identity, nameFor]);

  const handleSend = async () => {
    if (!identity || (!input.trim() && pendingFiles.length === 0)) return;
    const recipients =
      selected?.type === "dm"
        ? [selected.otherKeyHash]
        : selected?.type === "group"
          ? selected.memberKeyHashes.filter((k) => k !== identity.keyHash)
          : [];

    // The composer clears at once; the message shows faded until the server has it (see useMessages' outbox).
    // Plugins that asked may change the text first (sandboxed; at most 0.5 s each).
    const draft = plugins && input.trim() ? await plugins.beforeSend(input.trim()) : input.trim();
    const { body: text, mentions } = encodeDraft(draft, picked);
    const files = pendingFiles;
    setInput("");
    setPicked([]);
    setMentionQuery(null);
    setPendingFiles([]);
    const sentMentions = mentions.length ? mentions : undefined;

    if (text) {
      if (selected?.type === "dm") {
        await sendMessage(
          { type: "text", body: text, mentions: sentMentions } as Omit<DecryptedMessage, "senderKeyHash" | "sentAt" | "messageId">,
          recipients,
          { recipientKeyHash: selected.otherKeyHash }
        );
      } else if (selected?.type === "group") {
        await sendMessage(
          { type: "text", body: text, groupMemberKeyHashes: selected.memberKeyHashes, mentions: sentMentions } as Omit<DecryptedMessage, "senderKeyHash" | "sentAt" | "messageId">,
          recipients
        );
      }
      if (sentMentions) notifyMentions(sentMentions, recipients).catch(() => {});
    }

    for (const file of files) {
      const body = await readFileAsBase64(file);
      const fileMsg = {
        type: "file" as const,
        body,
        filename: file.name,
        fileSize: file.size,
        ...(selected?.type === "group" ? { groupMemberKeyHashes: selected.memberKeyHashes } : {}),
      };
      if (selected?.type === "dm") {
        await sendMessage(
          fileMsg as Omit<DecryptedMessage, "senderKeyHash" | "sentAt" | "messageId">,
          recipients,
          { recipientKeyHash: selected.otherKeyHash }
        );
      } else if (selected?.type === "group") {
        await sendMessage(fileMsg as Omit<DecryptedMessage, "senderKeyHash" | "sentAt" | "messageId">, recipients);
      }
    }
  };

  const handleCreateGroup = () => {
    if (newGroupSelected.size === 0) return;
    const conv: Conversation = {
      type: "group",
      memberKeyHashes: [identity!.keyHash, ...Array.from(newGroupSelected)],
    };
    setSelected(conv);
    setSidebarVisible(false);
    setNewGroupOpen(false);
    setNewGroupSelected(new Set());
  };

  const handleStartCall = async () => {
    if (!identity || !selected) return;
    setCurrentCallConversation(selected);
    // Join the ongoing call, or start one in a fresh random room.
    const callRoomId = ongoingRoom ?? newRoomId();
    const allowedKeyHashes =
      selected.type === "dm"
        ? [identity.keyHash, selected.otherKeyHash].sort()
        : [...selected.memberKeyHashes].sort();
    const sendStartedIfFirst = async () => {
      if (!selected || !identity) return;
      if (selected.type === "dm") {
        await sendMessage(
          { type: "call_event", event: "started", recipientKeyHash: selected.otherKeyHash, roomId: callRoomId } as Omit<DecryptedMessage, "senderKeyHash" | "sentAt" | "messageId">,
          [selected.otherKeyHash],
          { recipientKeyHash: selected.otherKeyHash }
        );
      } else {
        await sendMessage(
          { type: "call_event", event: "started", groupMemberKeyHashes: selected.memberKeyHashes, roomId: callRoomId } as Omit<DecryptedMessage, "senderKeyHash" | "sentAt" | "messageId">,
          selected.memberKeyHashes.filter((k) => k !== identity.keyHash)
        );
      }
    };
    await startOrJoinCall(callRoomId, identity.keyHash, allowedKeyHashes, sendStartedIfFirst);
  };

  const handleHangUp = async () => {
    const conv = currentCallConversation;
    const wasLast = await hangUp(currentRoomId || undefined);
    if (wasLast && identity && conv) {
      if (conv.type === "dm") {
        await sendMessage(
          { type: "call_event", event: "ended", recipientKeyHash: conv.otherKeyHash } as Omit<DecryptedMessage, "senderKeyHash" | "sentAt" | "messageId">,
          [conv.otherKeyHash],
          { recipientKeyHash: conv.otherKeyHash }
        );
      } else {
        await sendMessage(
          { type: "call_event", event: "ended", groupMemberKeyHashes: conv.memberKeyHashes } as Omit<DecryptedMessage, "senderKeyHash" | "sentAt" | "messageId">,
          conv.memberKeyHashes.filter((k) => k !== identity.keyHash)
        );
      }
    }
  };

  /** A DM partner who is no longer in the member directory (removed, or re-enrolled with a new key). */
  const isInactive = (conv: Conversation | null) => conv?.type === "dm" && directoryLoaded && !getMember(conv.otherKeyHash);
  const selectedInactive = isInactive(selected);

  // On a phone, set up only inside the installed app (its storage is separate from the browser tab's).
  if (installFirst && !loading && (!server || needsSetup)) return <InstallFirst />;

  // Server first: each server has its own identity.
  if (!loading && (!server || addingServer)) return <JoinServer onClose={server ? () => setAddingServer(false) : undefined} />;

  if (loading) return <main className="min-h-screen bg-[var(--bg)]" />;

  if (lockedFile) return <UnlockIdentity />;

  if (needsSetup) return <CreateIdentity />;

  if (!identity) {
    const message = identityError ?? "Something went wrong.";
    const lines = message.split("\n");
    const headline = lines[0];
    const detail = lines.slice(1).join("\n").trim();
    return (
      <main
        className="min-h-screen flex flex-col items-center justify-center p-6 bg-[var(--bg)] text-[var(--text)]"
        style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}
      >
        <h1 className="text-xl font-semibold mb-3">Exurelay</h1>
        <p className="text-center max-w-sm font-medium mb-2">{headline}</p>
        {detail && (
          <pre className="text-[var(--muted)] text-xs text-left max-w-sm whitespace-pre-wrap bg-[var(--surface)] rounded p-3 mb-4 border border-[var(--border)]">
            {detail}
          </pre>
        )}
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="px-4 py-2 rounded bg-[var(--accent)] text-white text-sm"
        >
          Retry
        </button>
      </main>
    );
  }

  if (!directoryLoaded) return <main className="min-h-screen bg-[var(--bg)]" />;

  if (!enrolled) return <NotEnrolled />;

  return (
    <main className="flex h-screen overflow-hidden bg-[var(--bg)] text-[var(--text)]">
      <TokenWarning />

      {/* ── Sidebar ────────────────────────────────────────────────────────── */}
      {/* Mobile: full-screen when sidebarVisible. Desktop (md+): always shown at 224px. */}
      <aside
        className={`flex-col bg-[var(--surface)] border-r border-[var(--border)] w-full md:w-56 md:flex-shrink-0 ${sidebarVisible ? "flex" : "hidden md:flex"}`}
      >
        {/* Header — uses safe-area-inset-top so it clears the iOS status bar */}
        <div
          className="px-3 pb-2 border-b border-[var(--border)] flex items-center justify-between gap-2"
          style={safeTop}
        >
          <span className="font-semibold text-sm">Chats</span>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setNewGroupOpen(true)}
              className="text-xs text-[var(--accent)] hover:opacity-80"
            >
              + Group
            </button>
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              className="text-xs text-[var(--accent)] hover:opacity-80"
            >
              Settings
            </button>
          </div>
        </div>

        {/* Which server: each has its own identity, members and chats */}
        <div className="px-3 py-2 border-b border-[var(--border)] flex">
          <ServerSwitcher onAdd={() => setAddingServer(true)} className="flex-1" />
        </div>

        {/* Conversation + contact list */}
        <ul className="flex-1 overflow-auto py-1">
          {conversations.map((conv) => {
            const key = conv.type === "dm"
              ? `dm:${conv.otherKeyHash}`
              : `g:${[...conv.memberKeyHashes].sort().join(",")}`;
            const isSelected =
              selected?.type === conv.type &&
              (conv.type === "dm"
                ? selected.type === "dm" && selected.otherKeyHash === conv.otherKeyHash
                : selected.type === "group" &&
                  selected.memberKeyHashes.length === conv.memberKeyHashes.length &&
                  [...selected.memberKeyHashes].sort().join() === [...conv.memberKeyHashes].sort().join());

            const openContextFor = () => {
              if (conv.type === "dm") {
                setDisplayNameModal({ keyHash: conv.otherKeyHash });
                setDisplayNameSaveError(null);
                setDisplayNameValue(getDisplayName(conv.otherKeyHash) ?? "");
              } else {
                setGroupRenameModal(conv);
                setGroupRenameValue(
                  groupNamesFromMessages.get(conversationId(conv, identity.keyHash)) || "Group Chat"
                );
              }
            };

            return (
              <li key={key}>
                <button
                  type="button"
                  onClick={() => {
                    if (longPressActivated.current) return;
                    setSelected(conv);
                    setSidebarVisible(false);
                    if (inCall) setCallExpanded(false);
                  }}
                  onContextMenu={(e) => { e.preventDefault(); openContextFor(); }}
                  onPointerDown={(e) => {
                    if (e.pointerType === "mouse") return;
                    longPressActivated.current = false;
                    longPressTimer.current = setTimeout(() => {
                      longPressActivated.current = true;
                      openContextFor();
                    }, 500);
                  }}
                  onPointerUp={endLongPress}
                  onPointerLeave={endLongPress}
                  onPointerCancel={endLongPress}
                  className={`w-full text-left px-3 py-2.5 text-sm truncate transition-colors ${isSelected ? "bg-[var(--accent)]/30" : "hover:bg-[var(--border)] active:bg-[var(--border)]"} ${isInactive(conv) ? "opacity-50" : ""}`}
                >
                  <span className="flex items-center gap-2">
                    <span className="truncate">{conversationLabel(conv, identity.keyHash, getDisplayName, groupNamesFromMessages)}</span>
                    {unreadMentions(conv) > 0 && (
                      <span
                        className="ml-auto shrink-0 px-1.5 rounded-full bg-amber-500 text-black text-xs font-semibold"
                        aria-label={`${unreadMentions(conv)} unread mentions`}
                      >
                        @{unreadMentions(conv)}
                      </span>
                    )}
                  </span>
                </button>
              </li>
            );
          })}

          {contactsWithoutDmSorted.map((c) => {
            const isSelected = selected?.type === "dm" && selected.otherKeyHash === c.keyHash;

            const openContextFor = () => {
              setDisplayNameModal({ keyHash: c.keyHash });
              setDisplayNameSaveError(null);
              setDisplayNameValue(getDisplayName(c.keyHash) ?? "");
            };

            return (
              <li key={`contact:${c.keyHash}`}>
                <button
                  type="button"
                  onClick={() => {
                    if (longPressActivated.current) return;
                    setSelected({ type: "dm", otherKeyHash: c.keyHash });
                    setSidebarVisible(false);
                    if (inCall) setCallExpanded(false);
                  }}
                  onContextMenu={(e) => { e.preventDefault(); openContextFor(); }}
                  onPointerDown={(e) => {
                    if (e.pointerType === "mouse") return;
                    longPressActivated.current = false;
                    longPressTimer.current = setTimeout(() => {
                      longPressActivated.current = true;
                      openContextFor();
                    }, 500);
                  }}
                  onPointerUp={endLongPress}
                  onPointerLeave={endLongPress}
                  onPointerCancel={endLongPress}
                  className={`w-full text-left px-3 py-2.5 text-sm truncate transition-colors ${isSelected ? "bg-[var(--accent)]/30" : "hover:bg-[var(--border)] active:bg-[var(--border)]"}`}
                >
                  {getDisplayName(c.keyHash) || c.keyHash.slice(0, 8)}
                </button>
              </li>
            );
          })}
        </ul>

        {/* Call controls — only when in a call */}
        {inCall && (
          <div className="p-2 border-t border-[var(--border)] flex flex-col gap-1.5 flex-shrink-0">
            <button type="button" onClick={() => setMuted(!muted)}
              className={`w-full py-2 rounded text-sm font-medium ${muted ? "bg-amber-600/80 text-white" : "bg-[var(--border)] text-[var(--text)]"}`}>
              {muted ? "Unmute" : "Mute"}
            </button>
            <button type="button" onClick={() => setDeafened(!deafened)}
              className={`w-full py-2 rounded text-sm font-medium ${deafened ? "bg-amber-600/80 text-white" : "bg-[var(--border)] text-[var(--text)]"}`}>
              {deafened ? "Undeafen" : "Deafen"}
            </button>
            <button type="button" onClick={() => setCameraOn(!cameraOn)}
              className={`w-full py-2 rounded text-sm font-medium ${cameraOn ? "bg-amber-600/80 text-white" : "bg-[var(--border)] text-[var(--text)]"}`}>
              {cameraOn ? "Camera off" : "Camera on"}
            </button>
            <button type="button" onClick={() => setScreenSharing(!screenSharing)}
              className={`w-full py-2 rounded text-sm font-medium ${screenSharing ? "bg-amber-600/80 text-white" : "bg-[var(--border)] text-[var(--text)]"}`}>
              {screenSharing ? "Stop share" : "Share screen"}
            </button>
            <button type="button" onClick={handleHangUp}
              className="w-full py-2 rounded text-sm font-medium bg-red-600/80 text-white">
              Hang up
            </button>
          </div>
        )}

        {/* Safe-area bottom spacer so sidebar content doesn't hide behind home indicator */}
        <div style={{ height: "env(safe-area-inset-bottom, 0px)" }} className="flex-shrink-0" />
      </aside>

      {/* ── Main chat panel ────────────────────────────────────────────────── */}
      {/* Mobile: full-screen when sidebar is hidden. Desktop: always visible flex-1. */}
      <div className={`flex-col min-w-0 flex-1 relative ${!sidebarVisible ? "flex" : "hidden md:flex"}`}>

        {roomJoinError && (
          <div className="flex items-center justify-between gap-2 px-4 py-2 bg-amber-900/40 border-b border-amber-600/50 text-sm text-amber-200">
            <span>{roomJoinError}</span>
            <button type="button" onClick={dismissRoomJoinError}
              className="px-2 py-1 rounded hover:bg-amber-600/30">
              Dismiss
            </button>
          </div>
        )}

        {/* Minimised call tile — positioned below the header, respecting safe area */}
        {inCall && !callExpanded && (
          <>
            <RemoteCallAudio />
            <div
              className="absolute right-2 z-10 w-40 rounded overflow-hidden border border-[var(--border)] bg-[var(--surface)] cursor-pointer shadow-lg"
              style={{ top: "calc(env(safe-area-inset-top, 0px) + 3.5rem)" }}
              onClick={() => setCallExpanded(true)}
              title="Click to expand call"
            >
              <CompactCallTile />
            </div>
          </>
        )}

        {inCall && callExpanded ? (
          <InlineCallView onHangUp={handleHangUp} />
        ) : selected ? (
          <>
            {/* Chat header — back button (mobile only) + conversation name + call button */}
            <div
              className="px-3 pb-2 border-b border-[var(--border)] flex items-center gap-2"
              style={safeTop}
            >
              <button
                type="button"
                onClick={() => setSidebarVisible(true)}
                className="md:hidden text-[var(--accent)] text-xl leading-none p-1 -ml-1 flex-shrink-0"
                aria-label="Back to chat list"
              >
                ←
              </button>
              <span className="flex-1 text-sm font-medium truncate">
                {conversationLabel(selected, identity.keyHash, getDisplayName, groupNamesFromMessages)}
              </span>
              {!inCall && !selectedInactive && (
                <button
                  type="button"
                  onClick={handleStartCall}
                  className="py-1.5 px-3 rounded text-sm bg-[var(--accent)] text-white font-medium hover:opacity-90 flex-shrink-0"
                >
                  {ongoingRoom ? "Join call" : "Call"}
                </button>
              )}
            </div>

            {selected.type === "dm" && <MemberNotice keyHash={selected.otherKeyHash} getMember={getMember} isRemoved={isRemoved} getDisplayName={getDisplayName} />}

            {/* Message list */}
            <ul
              ref={messagesListRef}
              onScroll={handleMessagesScroll}
              className="flex-1 overflow-auto px-3 py-2"
            >
              {filteredMessages.map((m, i) => {
                const prev = i > 0 ? filteredMessages[i - 1] : undefined;

                // System messages: call events and group renames
                if (m.type === "call_event") {
                  return (
                    <li key={i} className="text-xs text-center text-[var(--muted)] py-2 italic">
                      {m.event === "started"
                        ? `${m.senderKeyHash === identity.keyHash ? "You (" + getMyDisplayName() + ")" : getDisplayName(m.senderKeyHash) || m.senderKeyHash.slice(0, 8)} started a call · ${formatMsgTime(m.sentAt)}`
                        : `Call ended · ${formatMsgTime(m.sentAt)}`}
                    </li>
                  );
                }

                if (m.type === "group_rename") {
                  return (
                    <li key={i} className="text-xs text-center text-[var(--muted)] py-2 italic">
                      {m.senderKeyHash === identity.keyHash
                        ? "You (" + getMyDisplayName() + ")"
                        : getDisplayName(m.senderKeyHash) || m.senderKeyHash.slice(0, 8)}{" "}
                      renamed the group to {m.newName}
                    </li>
                  );
                }

                // Regular message
                const grouped = isGroupedWithPrev(m, prev);
                const forMe = mentionsMe(m, identity.keyHash);
                return (
                  <li
                    key={i}
                    className={`${grouped ? "mt-0.5" : "mt-3"} ${forMe ? "border-l-2 border-amber-400 bg-amber-500/5 pl-2 -ml-2" : ""}`}
                  >
                    {!grouped && (
                      <div className="flex items-baseline gap-2 mb-0.5">
                        <span className="text-xs font-semibold text-[var(--text)]">
                          {m.senderKeyHash === identity.keyHash
                            ? "Me (" + getMyDisplayName() + ")"
                            : getDisplayName(m.senderKeyHash) || m.senderKeyHash.slice(0, 8)}
                        </span>
                        <span className="text-xs text-[var(--muted)]">{formatMsgTime(m.sentAt)}</span>
                      </div>
                    )}
                    <div className={`text-sm ${m.outbox?.status === "sending" ? "opacity-50" : ""}`}>
                      {m.type === "text" && (
                        <MessageText
                          body={m.body}
                          myKeyHash={identity.keyHash}
                          nameFor={nameFor}
                          inGroup={!!m.groupMemberKeyHashes}
                          fromMe={m.senderKeyHash === identity.keyHash}
                        />
                      )}
                      {m.type === "file" && (
                        <span className="inline-flex items-center gap-2">
                          <span className="text-[var(--muted)]">[File: {m.filename || "file"}]</span>
                          {m.removed ? (
                            <span className="text-xs text-[var(--muted)]">removed from this device</span>
                          ) : (
                            <button
                              type="button"
                              onClick={() => downloadFile(m.body, m.filename || "download")}
                              className="px-2 py-0.5 rounded text-xs bg-[var(--accent)] text-white hover:opacity-90"
                            >
                              Download
                            </button>
                          )}
                        </span>
                      )}
                      {m.type === "contact" && <span className="text-[var(--muted)]">[Contact]</span>}
                      {m.type === "plugin" && (
                        <PluginMessage
                          type={m.pluginType}
                          data={m.data}
                          fallback={m.fallback}
                          mine={m.senderKeyHash === identity.keyHash}
                          sender={nameFor(m.senderKeyHash)}
                        />
                      )}
                    </div>
                    {m.outbox?.status === "failed" && (
                      <div className="flex items-center gap-1 text-xs text-red-500">
                        Not sent
                        <button
                          type="button"
                          aria-label="Retry sending"
                          title="Retry"
                          className="p-1 rounded hover:bg-[var(--border)]"
                          onClick={() => retrySend(m.outbox!.id)}
                        >
                          <RetryIcon />
                        </button>
                        <button
                          type="button"
                          aria-label="Cancel sending"
                          title="Cancel"
                          className="p-1 rounded hover:bg-[var(--border)] text-[var(--muted)]"
                          onClick={() => cancelSend(m.outbox!.id)}
                        >
                          <CancelIcon />
                        </button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>

            {/* Compose bar — bottom padding respects iOS home indicator unless keyboard is up */}
            <div
              className={`px-2 pt-2 border-t border-[var(--border)] flex-col gap-2 ${selectedInactive ? "hidden" : "flex"}`}
              style={keyboardVisible ? { paddingBottom: "0.5rem" } : safeBottom}
              onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                const files = Array.from(e.dataTransfer?.files ?? []);
                if (files.length) setPendingFiles((prev) => [...prev, ...files]);
              }}
            >
              {pendingFiles.length > 0 && (
                <div className="flex flex-wrap gap-1.5 text-xs text-[var(--muted)]">
                  {pendingFiles.map((f, idx) => (
                    <span key={idx} className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-[var(--border)]">
                      {f.name}
                      <button
                        type="button"
                        onClick={() => setPendingFiles((prev) => prev.filter((_, j) => j !== idx))}
                        className="hover:text-[var(--text)]"
                        aria-label="Remove"
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <MentionPicker candidates={mentionCandidates} active={mentionActive} onPick={pickMention} />
              <div className="flex gap-2">
                {/*
                  sr-only keeps the input in the DOM (not display:none) so iOS Safari
                  recognises the label click as a real user gesture and opens the file picker.
                */}
                <input
                  id="relay-file-input"
                  ref={fileInputRef}
                  type="file"
                  multiple
                  className="sr-only"
                  onChange={(e) => {
                    const files = Array.from(e.target.files ?? []);
                    if (files.length) setPendingFiles((prev) => [...prev, ...files]);
                    e.target.value = "";
                  }}
                />
                <label
                  htmlFor="relay-file-input"
                  className="px-3 py-2 rounded border border-[var(--border)] text-[var(--text)] hover:bg-[var(--border)] flex-shrink-0 cursor-pointer select-none"
                  title="Attach file"
                >
                  📎
                </label>
                <input
                  ref={composerRef}
                  type="text"
                  value={input}
                  onChange={(e) => {
                    setInput(e.target.value);
                    setMentionQuery(activeMentionQuery(e.target.value, e.target.selectionStart ?? e.target.value.length));
                    setMentionActive(0);
                  }}
                  onKeyDown={(e) => {
                    if (mentionCandidates.length > 0) {
                      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                        e.preventDefault();
                        const n = mentionCandidates.length;
                        setMentionActive((a) => (a + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
                        return;
                      }
                      if (e.key === "Enter" || e.key === "Tab") {
                        e.preventDefault();
                        pickMention(mentionCandidates[Math.min(mentionActive, mentionCandidates.length - 1)]);
                        return;
                      }
                      if (e.key === "Escape") {
                        setMentionQuery(null);
                        return;
                      }
                    }
                    if (e.key === "Enter") handleSend();
                  }}
                  onBlur={() => setMentionQuery(null)}
                  placeholder="Message... (@ to mention)"
                  className="flex-1 min-w-0 px-3 py-2 rounded bg-[var(--surface)] border border-[var(--border)] text-[var(--text)] placeholder-[var(--muted)]"
                />
                <button
                  type="button"
                  onClick={handleSend}
                  className="px-4 py-2 rounded bg-[var(--accent)] text-white font-medium flex-shrink-0"
                >
                  Send
                </button>
              </div>
            </div>
          </>
        ) : (
          /* Empty state — only visible on desktop when no chat is selected */
          <div className="flex-1 flex items-center justify-center text-[var(--muted)] text-sm">
            Select a chat or create a group
          </div>
        )}
      </div>

      {/* Error toast */}
      {error && (
        <div className="fixed bottom-4 right-4 px-3 py-2 rounded bg-red-900/80 text-white text-sm z-50">
          {error}
        </div>
      )}

      {/* ── Modals ─────────────────────────────────────────────────────────── */}

      {settingsOpen && (
        <SettingsModal
          onClose={() => setSettingsOpen(false)}
          storage={storage}
          sendHistory={sendHistory}
          conversations={conversations.map((c) => ({ conv: c, label: conversationLabel(c, identity.keyHash, getDisplayName, groupNamesFromMessages) }))}
        />
      )}

      {newGroupOpen && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-20 p-4">
          <div className="bg-[var(--surface)] border border-[var(--border)] rounded-lg p-4 w-full max-w-sm">
            <h2 className="font-semibold mb-2">New group</h2>
            <p className="text-sm text-[var(--muted)] mb-2">Select contacts to add.</p>
            <ul className="max-h-48 overflow-auto space-y-1 mb-4">
              {identity.contacts
                .filter((c) => c.keyHash !== identity.keyHash)
                .map((c) => (
                  <li key={c.keyHash}>
                    <label className="flex items-center gap-2 cursor-pointer py-1">
                      <input
                        type="checkbox"
                        checked={newGroupSelected.has(c.keyHash)}
                        onChange={(e) => {
                          setNewGroupSelected((prev) => {
                            const next = new Set(prev);
                            if (e.target.checked) next.add(c.keyHash);
                            else next.delete(c.keyHash);
                            return next;
                          });
                        }}
                      />
                      <span className="text-sm">{getDisplayName(c.keyHash) || c.keyHash.slice(0, 8)}</span>
                    </label>
                  </li>
                ))}
            </ul>
            <div className="flex gap-2">
              <button type="button" onClick={() => setNewGroupOpen(false)}
                className="flex-1 py-2 rounded border border-[var(--border)] text-sm">
                Cancel
              </button>
              <button type="button" onClick={handleCreateGroup}
                className="flex-1 py-2 rounded bg-[var(--accent)] text-white text-sm">
                Create
              </button>
            </div>
          </div>
        </div>
      )}

      {displayNameModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-20 p-4">
          <div className="bg-[var(--surface)] border border-[var(--border)] rounded-lg p-4 w-full max-w-sm">
            <h2 className="font-semibold mb-1">Set nickname</h2>
            <p className="text-xs text-[var(--muted)] mb-2">Only you see this. Leave empty to use their own name.</p>
            <input
              type="text"
              value={displayNameValue}
              onChange={(e) => { setDisplayNameValue(e.target.value); setDisplayNameSaveError(null); }}
              placeholder="Name"
              className="w-full px-3 py-2 rounded bg-[var(--bg)] border border-[var(--border)] text-[var(--text)] mb-4 text-sm"
            />
            {displayNameSaveError && (
              <p className="text-sm text-red-500 mb-2">{displayNameSaveError}</p>
            )}
            <div className="flex gap-2">
              <button type="button" disabled={displayNameSaving}
                onClick={() => { setDisplayNameModal(null); setDisplayNameSaveError(null); }}
                className="flex-1 py-2 rounded border border-[var(--border)] text-sm">
                Cancel
              </button>
              <button
                type="button"
                disabled={displayNameSaving}
                onClick={async () => {
                  const name =
                    displayNameValue.trim() ||
                    getDisplayName(displayNameModal.keyHash) ||
                    displayNameModal.keyHash.slice(0, 8);
                  setDisplayNameSaveError(null);
                  setDisplayNameSaving(true);
                  try {
                    await setDisplayName(displayNameModal.keyHash, name);
                    setDisplayNameModal(null);
                    setDisplayNameValue("");
                  } catch (e) {
                    setDisplayNameSaveError(e instanceof Error ? e.message : "Failed to save name");
                  } finally {
                    setDisplayNameSaving(false);
                  }
                }}
                className="flex-1 py-2 rounded bg-[var(--accent)] text-white text-sm disabled:opacity-50"
              >
                {displayNameSaving ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}

      {groupRenameModal && groupRenameModal.type === "group" && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-20 p-4">
          <div className="bg-[var(--surface)] border border-[var(--border)] rounded-lg p-4 w-full max-w-sm">
            <h2 className="font-semibold mb-2">Rename group</h2>
            <input
              type="text"
              value={groupRenameValue}
              onChange={(e) => setGroupRenameValue(e.target.value)}
              placeholder="Group name"
              className="w-full px-3 py-2 rounded bg-[var(--bg)] border border-[var(--border)] text-[var(--text)] mb-4 text-sm"
            />
            <div className="flex gap-2">
              <button type="button"
                onClick={() => { setGroupRenameModal(null); setGroupRenameValue(""); }}
                className="flex-1 py-2 rounded border border-[var(--border)] text-sm">
                Cancel
              </button>
              <button
                type="button"
                onClick={async () => {
                  const newName = groupRenameValue.trim() || "Group Chat";
                  await sendMessage(
                    {
                      type: "group_rename",
                      newName,
                      groupMemberKeyHashes: groupRenameModal.memberKeyHashes,
                    } as Omit<DecryptedMessage, "senderKeyHash" | "sentAt" | "messageId">,
                    groupRenameModal.memberKeyHashes.filter((k) => k !== identity.keyHash)
                  );
                  setGroupRenameModal(null);
                  setGroupRenameValue("");
                }}
                className="flex-1 py-2 rounded bg-[var(--accent)] text-white text-sm"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

/** Key-change and removal notices for a DM, from the signed member directory. */
function MemberNotice({
  keyHash,
  getMember,
  isRemoved,
  getDisplayName,
}: {
  keyHash: string;
  getMember: (keyHash: string) => { replaces?: string; enrolledAt: number } | undefined;
  isRemoved: (keyHash: string) => boolean;
  getDisplayName: (keyHash: string) => string | undefined;
}) {
  const member = getMember(keyHash);
  let text: string | null = null;
  if (!member && isRemoved(keyHash)) {
    text = "This member left, was removed, or got a new key. You can't message them here any more.";
  } else if (member?.replaces) {
    const old = getDisplayName(member.replaces) || member.replaces.slice(0, 8);
    text = `New key since ${new Date(member.enrolledAt).toLocaleDateString()}: the admin re-enrolled this member, replacing ${old}'s old key. Older messages are in that conversation.`;
  }
  if (!text) return null;
  return <div className="px-3 py-2 text-xs bg-amber-900/30 text-amber-200 border-b border-[var(--border)]">{text}</div>;
}
