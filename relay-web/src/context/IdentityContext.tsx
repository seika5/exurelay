"use client";

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { exportPrivateKey, exportPublicKey, generateKeyPair, generateSigningKeyPair, importIdentityKeys, importPublicKey } from "@/lib/crypto";
import { confirmDialog } from "@/components/Modal";
import { createIdentityFile, openIdentityFile, rewriteSettings, type FileSession } from "@/lib/identityFile";
import { getKeyHashFromKeyPair } from "@/lib/e2ee";
import { ApiError, getDirectory, getProfileCopies, postDeviceCert, postDeviceRevoke, postLeave, postProfileCopies, publishDirectory } from "@/lib/api";
import { openProfile, sealProfile, type ProfilePayload, type ReceivedCopy } from "@/lib/profileSeal";
import {
  deleteFolderRef,
  deleteIdentity,
  deletePushPeers,
  savePushPeers,
  ensureFolderAccess,
  identityFileName,
  loadFolderRef,
  loadIdentity,
  readFolderFile,
  removeFolderFile,
  requestPersistentStorage,
  saveFolderRef,
  saveIdentity,
  writeFolderFile,
  type Contact,
  type ContactSettings,
  type FolderRef,
} from "@/lib/keystore";
import {
  createEnrollmentCode as buildEnrollmentCode,
  directoryWithoutMembers,
  directoryWithAdmins,
  MAX_NAME_LENGTH,
  signRecord,
  verifyDepartures,
  verifyDevices,
  deviceCert,
  deviceRevoke,
  readEnrollmentCode,
  type MemberDevice,
  verifyDirectory,
  readIntroduction,
  readSignedName,
  type Directory,
  type DirectoryMember,
  type Profile,
} from "@/lib/signed";
import {
  listServers,
  loadServerConfig,
  normalizeServerUrl,
  readJoinCode,
  removeServerConfig,
  saveServerConfig,
  serverScopedKey,
  switchServerConfig,
  takeJoinFromLocation,
  type ServerConfig,
} from "@/lib/server";
import { setSigner } from "@/lib/session";
import { appCacheKey, wipeCache } from "@/lib/messageCache";
import { clearWallet, resetWalletMemory, setTokenDirectory } from "@/lib/tokens";

/** Newest directory version this device has accepted for the current server (rollback protection). */
const DIRECTORY_VERSION_KEY = "relay.directoryVersion";
const DIRECTORY_POLL_MS = 60_000;
const WAITING_POLL_MS = 5_000;

type IdentityState = {
  /** The one server this identity belongs to. */
  server: string;
  keyPair: CryptoKeyPair;
  signingKeyPair: CryptoKeyPair;
  keyHash: string;
  publicKeyBase64: string;
  signingPublicKeyBase64: string;
  myName: string;
  contactSettings: ContactSettings[];
  /** When myName/contactSettings last changed on any of my devices (for syncing them between devices). */
  settingsAt?: number;
  /** Active directory members other than me, with resolved names and devices. Derived from the verified directory. */
  contacts: Contact[];
  /**
   * keyHash above is the member I am (my enrolled key's hash, which every device of mine shares); this is this
   * device's own key hash. The same on the enrolled device.
   */
  deviceKeyHash: string;
  /** My devices (enrolled one first), this one included. */
  myDevices: MemberDevice[];
};

/**
 * Where a new identity is kept: in a folder the user picked, as a passphrase-encrypted file (desktop Chrome/Edge),
 * or in the app's own storage (everywhere else).
 */
export type StorageChoice = { kind: "app" } | { kind: "folder"; dir: FileSystemDirectoryHandle; passphrase: string };

/** Where the active identity lives, for Settings. */
export type IdentityStorage = { kind: "app" } | { kind: "folder"; folder: string; fileName: string };

type IdentityContextValue = {
  identity: IdentityState | null;
  /** True until the initial identity load has completed. */
  loading: boolean;
  /** No identity for the active server on this device yet: show the create-identity screen. */
  needsSetup: boolean;
  /** The active server's identity is in a folder: show the unlock screen (passphrase). */
  lockedFile: { folder: string; fileName: string } | null;
  /** Decrypt the locked identity file. Call from a submit/click: the browser may ask for folder access. */
  unlockIdentity: (passphrase: string) => Promise<void>;
  /** Point this server at a folder holding its identity file (after the folder moved, or site data was cleared). */
  openIdentityFolder: (dir: FileSystemDirectoryHandle) => Promise<void>;
  identityStorage: IdentityStorage | null;
  /** Key for this identity's local message cache (messageCache.ts): undefined while loading, null if unavailable. */
  cacheKey: CryptoKey | null | undefined;
  error: string | null;
  dismissError: () => void;
  /** name is "" when this device will be linked to a member I already am (its name comes from my other devices). */
  createIdentity: (name: string, storage: StorageChoice) => Promise<void>;
  /** Verified member directory, or null before the first admin publishes one. */
  directory: Directory | null;
  directoryLoaded: boolean;
  directoryError: string | null;
  refreshDirectory: () => Promise<void>;
  /** I'm an active member of the verified directory. */
  enrolled: boolean;
  /** My signing key is one of the admins pinned for this server. */
  isAdmin: boolean;
  /** The server this app talks to and the admins it trusts there; null until the user joins one. */
  server: ServerConfig | null;
  /** Join with a RELAY-JOIN: code or link. Throws with a readable message if it's invalid. */
  joinServer: (codeOrLink: string) => void;
  /** First admin of a brand-new server: create an identity for it and pin its signing key as the admin. */
  setUpNewServer: (url: string, name: string, storage: StorageChoice) => Promise<void>;
  /** Every server this app has joined; `server` is the active one. */
  servers: ServerConfig[];
  /** Make another joined server active. Each server keeps its own tokens and state. */
  switchServer: (url: string) => void;
  /**
   * Leave the active server: tell it (signed, so it deletes you as a member at once), then delete this server's
   * identity, tokens and rollback state, and switch to another joined server if any. Throws if the server couldn't
   * be told; with force, leaves this device anyway (you stay listed until an admin removes you).
   */
  leaveServer: (opts?: { force?: boolean }) => Promise<void>;
  /** Admin only: sign and publish the next directory version. */
  /** setupCode: the server's one-time setup code, for the first member list only. */
  publishSignedDirectory: (next: Directory, setupCode?: string) => Promise<void>;
  getMember: (keyHash: string) => DirectoryMember | undefined;
  isRemoved: (keyHash: string) => boolean;
  /** For others: a local nickname. For me: my display name, signed and published to the directory. */
  setDisplayName: (keyHash: string, displayName: string) => Promise<void>;
  getDisplayName: (keyHash: string) => string | undefined;
  getContactVolume: (keyHash: string) => number;
  setContactVolume: (keyHash: string, volume: number) => void;
  /** Label shown in parentheses for "Me (...)". */
  getMyDisplayName: () => string;
  /** Fresh signed enrollment code (valid 3 minutes) for the admin to paste or scan. */
  createEnrollmentCode: () => Promise<string>;
  logout: () => void;
  /** Approve a new device of mine from its enrollment code (shown on its waiting screen). */
  linkDevice: (code: string, name: string) => Promise<void>;
  /** A device this one just linked, until its message history has been sent to it (page.tsx). */
  justLinked: string | null;
  clearJustLinked: () => void;
  /** Admin, after enrolling: introduce the new member by the name in their signed code until theirs arrives. */
  rememberIntro: (keyHash: string, code: string) => void;
  /** Unlink one of my devices; unlinking this one also wipes it here. */
  unlinkDevice: (deviceKeyHash: string) => Promise<void>;
  /** Apply name and contact settings synced from another of my devices, if newer. */
  applyDeviceSync: (sync: { myName: string; contactSettings: ContactSettings[]; settingsAt: number }) => void;
  /** Bumped when name or contact settings change on this device, so the chat can sync them to my other devices. */
  settingsChangedAt: number;
  /** Every member's verified devices (enrolled first), by member keyHash. */
  memberDevices: Map<string, MemberDevice[]>;
  /** Admin only: move my admin rights from this device to another of my devices (it becomes the admin device). */
  moveAdmin: (deviceKeyHash: string) => Promise<void>;
  /** This device was unlinked from its account: its keys can't be linked again, so it must start over. */
  unlinked: boolean;
  startOver: () => Promise<void>;
};

const IdentityContext = createContext<IdentityContextValue | null>(null);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readMinDirectoryVersion(): number {
  try {
    return Number(localStorage.getItem(serverScopedKey(DIRECTORY_VERSION_KEY))) || 0;
  } catch {
    return 0;
  }
}

function writeMinDirectoryVersion(version: number) {
  try {
    localStorage.setItem(serverScopedKey(DIRECTORY_VERSION_KEY), String(version));
  } catch {
    // Storage unavailable: rollback protection only lasts for this session.
  }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/** What's stored for an identity: this device's keys, my name and contact settings. Member and devices are derived. */
type BaseIdentity = Omit<IdentityState, "contacts" | "deviceKeyHash" | "myDevices">;

/** Names for my devices, by device key hash, and when they last changed. Shared only sealed to my own devices. */
type DeviceNames = { at: number; names: Record<string, string> };
const DEVICE_NAMES_KEY = "relay.deviceNames";
/** What this device last sent each recipient device (updatedAt, name, device names), so it re-sends only changes. */
const PROFILE_SENT_KEY = "relay.profileSent";
const MAX_DEVICE_NAMES = 24;
/**
 * Enrollment codes of members this device enrolled, kept until their own name arrives and passed along to everyone in
 * my sealed copies meanwhile (profileSeal.ts `intros`), so a new member shows by name even before their app is open.
 */
const INTROS_KEY = "relay.intros";
const MAX_INTROS = 6;
/** Signed names of others passed along in each copy (each about 300 bytes). */
const MAX_RELAY = 10;
/** A copy's padded plaintext must stay within 4096 bytes (the server takes ciphertexts up to 8192 base64 characters). */
const COPY_BUDGET = 4000;

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(serverScopedKey(key));
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(serverScopedKey(key), JSON.stringify(value));
  } catch {
    // Private mode or full storage: it only means re-sending copies later.
  }
}

/** Decrypt the sealed profiles addressed to this device. Copies from a device that isn't the author's are dropped. */
async function openProfiles(
  copies: ReceivedCopy[],
  myEcdh: CryptoKey,
  myDeviceKeyHash: string,
  devices: Map<string, MemberDevice[]>,
  members: DirectoryMember[],
  /** Introductions this device keeps itself (members it enrolled). */
  localIntros: string[] = []
): Promise<{
  profiles: Map<string, Profile>;
  ownDevices: Map<string, { at: number; names: Record<string, string> }>;
  /** Each member's newest verified signed name (JSON), to pass along to others. */
  signed: Map<string, { json: string; updatedAt: number }>;
}> {
  const profiles = new Map<string, Profile>();
  const ownDevices = new Map<string, { at: number; names: Record<string, string> }>();
  const intros = [...localIntros];
  const signedJson: string[] = [];
  for (const c of copies) {
    const sender = devices.get(c.author)?.find((d) => d.keyHash === c.sender);
    if (!sender) continue;
    const p = await openProfile(myEcdh, await importPublicKey(sender.ecdh), myDeviceKeyHash, c);
    if (!p) continue;
    if (p.intros) intros.push(...p.intros.slice(0, MAX_INTROS));
    if (p.signed) signedJson.push(p.signed);
    if (p.relay) signedJson.push(...p.relay.slice(0, MAX_RELAY));
    if (!p.name.trim()) continue;
    const prev = profiles.get(c.author);
    if (!prev || p.updatedAt > prev.updatedAt) {
      profiles.set(c.author, { type: "relay-profile", keyHash: c.author, name: p.name.slice(0, MAX_NAME_LENGTH), updatedAt: p.updatedAt });
    }
    if (p.devices) {
      const names = Object.fromEntries(
        Object.entries(p.devices)
          .filter(([k, v]) => typeof k === "string" && typeof v === "string")
          .slice(0, MAX_DEVICE_NAMES)
          .map(([k, v]) => [k, v.slice(0, MAX_NAME_LENGTH)])
      );
      const prevOwn = ownDevices.get(c.author);
      if (!prevOwn || p.updatedAt > prevOwn.at) ownDevices.set(c.author, { at: p.updatedAt, names });
    }
  }
  // Signed names, the author's own or passed along by others: verified against that member's devices. A newer one
  // than what arrived directly wins, so a new member learns everyone's current name from whoever is online.
  const signed = new Map<string, { json: string; updatedAt: number }>();
  for (const json of new Set(signedJson)) {
    const n = await readSignedName(json, (m) => (members.some((x) => x.keyHash === m) ? devices.get(m) : undefined));
    if (!n) continue;
    if ((signed.get(n.keyHash)?.updatedAt ?? -1) < n.updatedAt) signed.set(n.keyHash, { json, updatedAt: n.updatedAt });
    if ((profiles.get(n.keyHash)?.updatedAt ?? -1) < n.updatedAt) {
      profiles.set(n.keyHash, { type: "relay-profile", keyHash: n.keyHash, name: n.name, updatedAt: n.updatedAt });
    }
  }
  // Members whose own name hasn't arrived: the name from their signed enrollment code, if anyone passed it along.
  // updatedAt 0 marks it as an introduction, so their own copy replaces it as soon as it comes.
  for (const code of new Set(intros)) {
    const intro = await readIntroduction(code, members);
    if (intro && !profiles.has(intro.keyHash)) {
      profiles.set(intro.keyHash, { type: "relay-profile", keyHash: intro.keyHash, name: intro.name, updatedAt: 0 });
    }
  }
  return { profiles, ownDevices, signed };
}

export function IdentityProvider({ children }: { children: React.ReactNode }) {
  const [base, setBase] = useState<BaseIdentity | null>(null);
  const [loading, setLoading] = useState(true);
  const [needsSetup, setNeedsSetup] = useState(false);
  // Folder identity for the active server, waiting for its passphrase.
  const [locked, setLocked] = useState<FolderRef | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [directory, setDirectory] = useState<Directory | null>(null);
  const [profiles, setProfiles] = useState<Map<string, Profile>>(new Map());
  // Members who signed their own leave and are still listed until an admin publishes the next directory.
  const [departed, setDeparted] = useState<Set<string>>(new Set());
  // Every member's verified devices (enrolled key first), by member keyHash.
  const [devices, setDevices] = useState<Map<string, MemberDevice[]>>(new Map());
  // Devices validly unlinked: if this one is among them, its keys are dead and it has to start over.
  const [revokedDevices, setRevokedDevices] = useState<Set<string>>(new Set());
  const [settingsChangedAt, setSettingsChangedAt] = useState(0);
  const [directoryLoaded, setDirectoryLoaded] = useState(false);
  const [directoryError, setDirectoryError] = useState<string | null>(null);
  const [deviceNames, setDeviceNames] = useState<DeviceNames>({ at: 0, names: {} });
  const baseRef = useRef<BaseIdentity | null>(null);
  baseRef.current = base;
  const deviceNamesRef = useRef(deviceNames);
  deviceNamesRef.current = deviceNames;
  const publishingProfile = useRef(false);
  const [justLinked, setJustLinked] = useState<string | null>(null);
  const [intros, setIntros] = useState<Record<string, string>>({});
  const [signedNames, setSignedNames] = useState<Map<string, { json: string; updatedAt: number }>>(new Map());
  const ownSigned = useRef<{ key: string; json: string } | null>(null);
  const introsRef = useRef(intros);
  introsRef.current = intros;
  const clearJustLinked = useCallback(() => setJustLinked(null), []);

  const [server, setServer] = useState<ServerConfig | null>(null);
  const [servers, setServers] = useState<ServerConfig[]>([]);
  const [serverReady, setServerReady] = useState(false);
  const adminKeys = useMemo(() => server?.admins ?? [], [server]);

  // Server choice: a #join= link wins over a saved choice; otherwise saved, otherwise the build's preset.
  useEffect(() => {
    void (async () => {
      const fromLink = takeJoinFromLocation();
      const joined = fromLink ? readJoinCode(fromLink) : null;
      const saved = loadServerConfig();
      // Adding a server to an app already in use needs a yes: a link from a stranger mustn't repoint it silently.
      const known = joined?.ok ? listServers().find((c) => c.url === joined.config.url) : undefined;
      const sameAsKnown = known && known.admins.join() === (joined?.ok ? joined.config.admins.join() : "");
      if (joined?.ok && sameAsKnown) {
        setServer(switchServerConfig(joined.config.url));
      } else if (
        joined?.ok &&
        (!saved ||
          (await confirmDialog(
            known
              ? `This link trusts different admins for ${joined.config.url}. Replace them?`
              : `Join ${joined.config.url}? You stay in your other servers.`,
            known ? { ok: "Replace", danger: true } : { ok: "Join" }
          )))
      ) {
        saveServerConfig(joined.config);
        setServer(joined.config);
      } else {
        setServer(saved);
      }
      setServers(listServers());
      setServerReady(true);
    })();
  }, []);

  const resetServerState = useCallback(() => {
    setDirectory(null);
    setProfiles(new Map());
    setDeparted(new Set());
    setDirectoryLoaded(false);
    setDirectoryError(null);
    setTokenDirectory(null);
    resetWalletMemory();
  }, []);

  const activate = useCallback((config: ServerConfig | null) => {
    resetServerState();
    setServer(config);
    setServers(listServers());
  }, [resetServerState]);

  const joinServer = useCallback((codeOrLink: string) => {
    const r = readJoinCode(codeOrLink);
    if (!r.ok) throw new Error(r.error);
    saveServerConfig(r.config);
    activate(r.config);
  }, [activate]);

  const switchServer = useCallback((url: string) => {
    if (url === server?.url) return;
    const next = switchServerConfig(url);
    if (next) activate(next);
  }, [server, activate]);

  // Identities already loaded this session, by server, so switching back doesn't reload (or lose) them.
  const identities = useRef(new Map<string, BaseIdentity>());
  const activeUrl = useRef<string | null>(null);

  // Folder identities unlocked this session, by server: enough to save settings back, without the passphrase.
  const fileSessions = useRef(new Map<string, { ref: FolderRef; session: FileSession }>());

  const adopt = useCallback((next: BaseIdentity) => {
    identities.current.set(next.server, next);
    if (next.server === activeUrl.current) {
      setBase(next);
      setNeedsSetup(false);
      setLocked(null);
    }
  }, []);

  /** Save name and contact settings wherever this identity lives. */
  const persist = useCallback(async (next: BaseIdentity) => {
    const f = fileSessions.current.get(next.server);
    if (f) {
      const bytes = await rewriteSettings(f.session, { myName: next.myName, contactSettings: next.contactSettings, settingsAt: next.settingsAt });
      await writeFolderFile(f.ref.dir, f.ref.fileName, bytes);
    } else {
      await saveIdentity(next);
    }
  }, []);

  /**
   * Make and store a new identity. It's saved before it's used: one that only existed in memory would be gone on
   * reload, after the admin had enrolled it.
   */
  const newIdentity = async (serverUrl: string, name: string, storage: StorageChoice): Promise<BaseIdentity> => {
    // Empty when linking this device to a member I already am: the name then arrives from my other devices (device_sync).
    const trimmed = name.trim().slice(0, MAX_NAME_LENGTH);
    const folder = storage.kind === "folder";
    // Folder mode: extractable only long enough to write the encrypted file, then re-imported non-extractable.
    const ecdh = await generateKeyPair(folder);
    const signing = await generateSigningKeyPair(folder);
    const publicKeyBase64 = await exportPublicKey(ecdh.publicKey);
    const signingPublicKeyBase64 = await exportPublicKey(signing.publicKey);
    let keys = { keyPair: ecdh, signingKeyPair: signing };
    if (storage.kind === "folder") {
      const fileName = identityFileName(serverUrl);
      if (!(await ensureFolderAccess(storage.dir))) throw new Error("Exurelay needs access to that folder to save your identity.");
      if (await readFolderFile(storage.dir, fileName)) {
        throw new Error(`That folder already has an identity for this server (${fileName}). Use "I already have an identity file", or pick another folder.`);
      }
      const { bytes, session } = await createIdentityFile(
        {
          server: serverUrl,
          ecdhPublic: publicKeyBase64,
          ecdhPrivate: await exportPrivateKey(ecdh.privateKey),
          signingPublic: signingPublicKeyBase64,
          signingPrivate: await exportPrivateKey(signing.privateKey),
        },
        { myName: trimmed, contactSettings: [] },
        storage.passphrase
      );
      await writeFolderFile(storage.dir, fileName, bytes);
      const ref = { server: serverUrl, dir: storage.dir, fileName };
      await saveFolderRef(ref);
      fileSessions.current.set(serverUrl, { ref, session });
      keys = await importIdentityKeys({
        ecdhPublic: publicKeyBase64,
        ecdhPrivate: await exportPrivateKey(ecdh.privateKey),
        signingPublic: signingPublicKeyBase64,
        signingPrivate: await exportPrivateKey(signing.privateKey),
      });
    }
    const next: BaseIdentity = {
      server: serverUrl,
      ...keys,
      keyHash: await getKeyHashFromKeyPair(keys.keyPair),
      publicKeyBase64,
      signingPublicKeyBase64,
      myName: trimmed,
      contactSettings: [],
    };
    if (storage.kind === "app") {
      await saveIdentity(next);
      requestPersistentStorage();
    }
    return next;
  };

  /** A new identity for the active server. */
  const createIdentity = useCallback(async (name: string, storage: StorageChoice) => {
    setError(null);
    if (!server) throw new Error("Join a server first");
    adopt(await newIdentity(server.url, name, storage));
  }, [server, adopt]);

  const unlockIdentity = useCallback(async (passphrase: string) => {
    if (!locked) return;
    if (!(await ensureFolderAccess(locked.dir))) throw new Error("Exurelay needs access to the folder to read your identity.");
    const bytes = await readFolderFile(locked.dir, locked.fileName);
    if (!bytes) throw new Error(`${locked.fileName} isn't in the folder "${locked.dir.name}" any more. Choose the folder it's in now.`);
    const { keys, settings, session } = await openIdentityFile(bytes, passphrase);
    if (keys.server !== locked.server) throw new Error(`That file is the identity for ${keys.server}, not this server.`);
    const pairs = await importIdentityKeys(keys);
    fileSessions.current.set(locked.server, { ref: locked, session });
    adopt({
      server: keys.server,
      ...pairs,
      keyHash: await getKeyHashFromKeyPair(pairs.keyPair),
      publicKeyBase64: keys.ecdhPublic,
      signingPublicKeyBase64: keys.signingPublic,
      myName: settings.myName,
      contactSettings: settings.contactSettings ?? [],
      settingsAt: settings.settingsAt,
    });
  }, [locked, adopt]);

  const openIdentityFolder = useCallback(async (dir: FileSystemDirectoryHandle) => {
    if (!server) return;
    const fileName = identityFileName(server.url);
    if (!(await readFolderFile(dir, fileName))) throw new Error(`There's no ${fileName} in "${dir.name}".`);
    const ref = { server: server.url, dir, fileName };
    await saveFolderRef(ref);
    setNeedsSetup(false);
    setLocked(ref);
  }, [server]);

  const dismissError = useCallback(() => setError(null), []);

  // Load the active server's identity whenever the server changes. A missing file means "create one", not an error.
  useEffect(() => {
    if (!serverReady) return;
    activeUrl.current = server?.url ?? null;
    setError(null);
    setNeedsSetup(false);
    setLocked(null);
    const url = server?.url;
    const cached = url ? identities.current.get(url) : undefined;
    setBase(cached ?? null);
    if (!url || cached) {
      setLoading(false);
      return;
    }
    setLoading(true);
    let cancelled = false;
    (async () => {
      const ref = await loadFolderRef(url);
      if (cancelled) return;
      if (ref) return setLocked(ref);
      const stored = await loadIdentity(url);
      if (cancelled) return;
      if (stored) adopt(stored);
      else setNeedsSetup(true);
    })()
      .catch((e) => {
        if (!cancelled) setError(`Couldn't open this device's key storage: ${e instanceof Error ? e.message : e}`);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [serverReady, server?.url, adopt]);

  /** First admin of a brand-new server: a new identity for it, whose signing key is pinned as the admin. */
  const setUpNewServer = useCallback(async (url: string, name: string, storage: StorageChoice) => {
    const normalized = normalizeServerUrl(url);
    if (!name.trim()) throw new Error("Enter a name");
    const next = await newIdentity(normalized, name, storage);
    const config: ServerConfig = { url: normalized, admins: [next.signingPublicKeyBase64] };
    identities.current.set(normalized, next);
    saveServerConfig(config);
    activate(config);
    adopt(next);
  }, [activate, adopt]);

  // Logins (for tokens, admin requests and the socket) sign with this identity.
  useEffect(() => {
    setSigner(base ? { keyHash: base.keyHash, signingPrivateKey: base.signingKeyPair.privateKey } : null);
  }, [base, server]);

  // ---------------------------------------------------------------------------
  // Directory
  // ---------------------------------------------------------------------------

  const refreshDirectory = useCallback(async () => {
    if (!server) return;
    try {
      const res = await getDirectory();
      if (!res.directory) {
        setDirectory(null);
        setProfiles(new Map());
        setDeparted(new Set());
        setDirectoryError(null);
        return;
      }
      if (adminKeys.length === 0) {
        setDirectoryError("No admin keys are pinned for this server. Join again with a join code from your admin.");
        return;
      }
      const result = await verifyDirectory(res.directory, adminKeys, readMinDirectoryVersion());
      if (!result.ok) {
        // Keep the last good directory; never fall back to an unverified or older one.
        setDirectoryError(result.error);
        return;
      }
      writeMinDirectoryVersion(result.directory.version);
      // Admin changes arrive inside a list signed by an admin we already trust: re-pin to them.
      const nextAdmins = result.directory.admins;
      if (nextAdmins && nextAdmins.join(",") !== adminKeys.join(",")) {
        const config = { url: server.url, admins: nextAdmins };
        saveServerConfig(config);
        setServer(config);
        setServers(listServers());
      }
      setTokenDirectory(result.directory);
      setDirectory(result.directory);
      const revoked = new Set<string>();
      const verifiedDevices = await verifyDevices(res.devices ?? [], res.deviceRevocations ?? [], result.directory.members, revoked);
      setDevices(verifiedDevices);
      setRevokedDevices(revoked);
      // Names are sealed to each device (profileSeal.ts): fetch the copies for this one once it's a member.
      const me = baseRef.current;
      const meMember =
        me &&
        (result.directory.members.some((m) => m.keyHash === me.keyHash)
          ? me.keyHash
          : [...verifiedDevices].find(([, list]) => list.some((d) => d.keyHash === me.keyHash))?.[0]);
      if (me && meMember) {
        try {
          const opened = await openProfiles(
            await getProfileCopies(),
            me.keyPair.privateKey,
            me.keyHash,
            verifiedDevices,
            result.directory.members,
            Object.values(introsRef.current)
          );
          setProfiles(opened.profiles);
          setSignedNames(opened.signed);
          const own = opened.ownDevices.get(meMember);
          if (own && own.at > deviceNamesRef.current.at) {
            setDeviceNames(own);
            writeJson(`${DEVICE_NAMES_KEY}:${me.keyHash}`, own);
          }
        } catch {
          // Keep the names we have; the next refresh tries again.
        }
      } else {
        setProfiles(new Map());
      }
      setDeparted(await verifyDepartures(res.departures ?? [], result.directory.members));
      setDirectoryError(null);
    } catch (e) {
      const message = e instanceof Error ? e.message : "";
      setDirectoryError(
        ["Failed to fetch", "Load failed", "NetworkError when attempting to fetch resource."].includes(message)
          ? `Cannot reach the server (${server.url}).`
          : message || "Couldn't load the member list."
      );
    } finally {
      setDirectoryLoaded(true);
    }
  }, [server, adminKeys]);

  // The member this device belongs to: its own key if enrolled directly, else the member whose certified device it is.
  const myMember = useMemo(() => {
    if (!base || !directory) return null;
    if (directory.members.some((m) => m.keyHash === base.keyHash)) return base.keyHash;
    for (const [member, list] of devices) if (list.some((d) => d.keyHash === base.keyHash)) return member;
    return null;
  }, [base, directory, devices]);
  const enrolled = !!myMember && !departed.has(myMember);

  useEffect(() => {
    if (!base || !server) return;
    refreshDirectory();
    // Waiting to be enrolled or linked: check often, so the screen moves on soon after approval (the GET is anonymous).
    const timer = setInterval(refreshDirectory, enrolled ? DIRECTORY_POLL_MS : WAITING_POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") refreshDirectory();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [base, server, refreshDirectory, enrolled]);

  const isAdmin = !!base && adminKeys.includes(base.signingPublicKeyBase64);

  /** Delete this device's identity for a server, its file, cache, tokens and rollback state (leave or start over). */
  const forgetHere = useCallback(async (url: string) => {
    clearWallet();
    try {
      localStorage.removeItem(serverScopedKey(DIRECTORY_VERSION_KEY));
    } catch {
      // ignore
    }
    identities.current.delete(url);
    // The identity file goes too once we've left (it's useless after); while locked we couldn't sign the leave,
    // so the file stays and only this device forgets the server.
    const file = fileSessions.current.get(url)?.ref ?? (await loadFolderRef(url).catch(() => null));
    if (file) {
      if (base) {
        try {
          if (await ensureFolderAccess(file.dir)) await removeFolderFile(file.dir, file.fileName);
        } catch {
          // Couldn't delete it: it's no longer a member's key either way.
        }
      }
      await deleteFolderRef(url).catch(() => {});
    }
    fileSessions.current.delete(url);
    if (base) await wipeCache(base.keyHash).catch(() => {});
    await deletePushPeers(url).catch(() => {});
    await deleteIdentity(url);
    setBase(null);
    setLocked(null);
  }, [base]);

  /** This device's identity is dead (unlinked): delete it and go back to creating one, staying on this server. */
  const startOver = useCallback(async () => {
    if (!server) return;
    await forgetHere(server.url);
    setNeedsSetup(true);
  }, [server, forgetHere]);

  const leaveServer = useCallback(async ({ force = false }: { force?: boolean } = {}) => {
    if (!server) return;
    if (base && enrolled && !force) {
      const env = await signRecord(base.signingKeyPair.privateKey, {
        type: "relay-leave",
        keyHash: myMember,
        server: server.url,
        ts: Date.now(),
      });
      try {
        await postLeave(env);
      } catch (e) {
        // Already removed by an admin: nothing left to tell the server.
        if (!(e instanceof ApiError && e.message === "not a member")) throw e;
      }
    }
    await forgetHere(server.url);
    activate(removeServerConfig(server.url));
  }, [server, base, enrolled, myMember, activate, forgetHere]);

  // This device's device-name list for the active server.
  useEffect(() => {
    setDeviceNames(base ? readJson<DeviceNames>(`${DEVICE_NAMES_KEY}:${base.keyHash}`, { at: 0, names: {} }) : { at: 0, names: {} });
    setIntros(base ? readJson<Record<string, string>>(`${INTROS_KEY}:${base.keyHash}`, {}) : {});
  }, [server, base?.keyHash]); // eslint-disable-line react-hooks/exhaustive-deps -- only when the identity changes

  // Seal my name to every other current device (mine included), and my device names to my own devices only. Re-sends
  // only what changed for each recipient. updatedAt follows the settings synced between my devices, so a device that
  // hasn't caught up can't overwrite a newer name (the server keeps the newest copy).
  useEffect(() => {
    if (!base || !enrolled || !myMember || !directory || publishingProfile.current) return;
    const name = base.myName.trim();
    if (!name) return;
    const updatedAt = Math.max(base.settingsAt ?? 0, deviceNames.at, 1);
    const mine = devices.get(myMember) ?? [];
    const ownNames = Object.fromEntries(
      Object.entries(deviceNames.names)
        .filter(([k]) => mine.some((d) => d.keyHash === k))
        .slice(0, MAX_DEVICE_NAMES)
    );
    const targets: { keyHash: string; ecdh: string; own: boolean; member: string }[] = [];
    for (const m of directory.members) {
      if (departed.has(m.keyHash)) continue;
      for (const d of devices.get(m.keyHash) ?? [{ keyHash: m.keyHash, ecdh: m.ecdh }]) {
        if (d.keyHash !== base.keyHash) targets.push({ keyHash: d.keyHash, ecdh: d.ecdh, own: m.keyHash === myMember, member: m.keyHash });
      }
    }
    // Others' signed names I know, newest first, for passing along (not theirs back to them).
    const known = [...signedNames]
      .filter(([k]) => k !== myMember && directory.members.some((m) => m.keyHash === k) && !departed.has(k))
      .sort((x, y) => y[1].updatedAt - x[1].updatedAt);
    const relayFor = (member: string) => known.filter(([k]) => k !== member).slice(0, MAX_RELAY).map(([, v]) => v.json);
    // Members I enrolled whose own name hasn't arrived yet: pass their signed codes along.
    const shared = Object.entries(intros)
      .filter(([k]) => k !== myMember && !departed.has(k) && directory.members.some((m) => m.keyHash === k) && !profiles.get(k)?.updatedAt)
      .map(([, code]) => code)
      .slice(0, MAX_INTROS);
    const digest = (t: { own: boolean; member: string }) => JSON.stringify(["v2", updatedAt, name, t.own ? ownNames : null, shared, relayFor(t.member)]);
    const sentKey = `${PROFILE_SENT_KEY}:${base.keyHash}`;
    const sent = readJson<Record<string, string>>(sentKey, {});
    const todo = targets.filter((t) => sent[t.keyHash] !== digest(t));
    if (todo.length === 0) return;
    publishingProfile.current = true;
    (async () => {
      // My name, signed, so others can pass it along (re-signed only when it changes).
      const signKey = `${myMember}|${name}|${updatedAt}`;
      if (ownSigned.current?.key !== signKey) {
        const env = await signRecord(base.signingKeyPair.privateKey, { type: "relay-profile", keyHash: myMember, name, updatedAt });
        ownSigned.current = { key: signKey, json: JSON.stringify(env) };
      }
      const signedJson = ownSigned.current.json;
      // Fit each copy in the budget: drop passed-along names first, then introductions.
      const fit = (p: ProfilePayload): ProfilePayload => {
        const next = { ...p, relay: [...(p.relay ?? [])], intros: [...(p.intros ?? [])] };
        const size = () => new TextEncoder().encode(JSON.stringify(next)).length;
        while (size() > COPY_BUDGET && next.relay.length) next.relay.pop();
        while (size() > COPY_BUDGET && next.intros.length) next.intros.pop();
        if (!next.relay.length) delete (next as { relay?: string[] }).relay;
        if (!next.intros.length) delete (next as { intros?: string[] }).intros;
        return next;
      };
      const copies = await Promise.all(
        todo.map(async (t) =>
          sealProfile(
            base.keyPair.privateKey,
            await importPublicKey(t.ecdh),
            { author: myMember, sender: base.keyHash, recipient: t.keyHash },
            fit({
              name,
              updatedAt,
              signed: signedJson,
              ...(t.own ? { devices: ownNames } : {}),
              ...(shared.length ? { intros: shared } : {}),
              ...(relayFor(t.member).length ? { relay: relayFor(t.member) } : {}),
            })
          )
        )
      );
      await postProfileCopies(copies);
      const next = Object.fromEntries(targets.filter((t) => sent[t.keyHash] !== undefined).map((t) => [t.keyHash, sent[t.keyHash]]));
      for (const t of todo) next[t.keyHash] = digest(t);
      writeJson(sentKey, next);
    })()
      .catch(() => {
        // Not sent: the next directory refresh tries again.
      })
      .finally(() => {
        publishingProfile.current = false;
      });
  }, [base, enrolled, myMember, directory, devices, departed, deviceNames, intros, profiles, signedNames]);

  // Forget introductions once the member's own name has arrived, or they're no longer a member.
  useEffect(() => {
    if (!base || !directory) return;
    const keep = Object.fromEntries(
      Object.entries(intros).filter(([k]) => directory.members.some((m) => m.keyHash === k) && !profiles.get(k)?.updatedAt)
    );
    if (Object.keys(keep).length === Object.keys(intros).length) return;
    setIntros(keep);
    writeJson(`${INTROS_KEY}:${base.keyHash}`, keep);
  }, [base, directory, profiles, intros]);

  /** After enrolling a member: keep their signed enrollment code to introduce them until their own name arrives. */
  const rememberIntro = useCallback(
    (keyHash: string, code: string) => {
      if (!base) return;
      const next = { ...introsRef.current, [keyHash]: code.trim() };
      setIntros(next);
      writeJson(`${INTROS_KEY}:${base.keyHash}`, next);
    },
    [base]
  );

  const publishSignedDirectory = useCallback(async (next: Directory, setupCode?: string) => {
    if (!base || !isAdmin) throw new Error("Only an admin can change the member list");
    if (next.signer !== base.signingPublicKeyBase64) throw new Error("Directory signer must be this admin");
    await publishDirectory(await signRecord(base.signingKeyPair.privateKey, next), setupCode);
    await refreshDirectory();
  }, [base, isAdmin, refreshDirectory]);

  // Admin: drop members who left from the signed list, so everyone's directory catches up.
  const cleaningUp = useRef(false);
  useEffect(() => {
    if (!base || !isAdmin || !directory || departed.size === 0 || cleaningUp.current) return;
    cleaningUp.current = true;
    publishSignedDirectory(directoryWithoutMembers(directory, base.signingPublicKeyBase64, [...departed], Date.now(), devices))
      .catch(() => {})
      .finally(() => {
        cleaningUp.current = false;
      });
  }, [base, isAdmin, directory, departed, devices, publishSignedDirectory]);

  const getMember = useCallback(
    (keyHash: string) => (departed.has(keyHash) ? undefined : directory?.members.find((m) => m.keyHash === keyHash)),
    [directory, departed]
  );
  const isRemoved = useCallback(
    (keyHash: string) => departed.has(keyHash) || !!directory?.removed.some((r) => r.keyHash === keyHash),
    [directory, departed]
  );

  // ---------------------------------------------------------------------------
  // Names and local settings
  // ---------------------------------------------------------------------------

  const resolveName = useCallback(
    (keyHash: string, settings: ContactSettings[]): string | undefined =>
      settings.find((c) => c.keyHash === keyHash)?.nickname || profiles.get(keyHash)?.name,
    [profiles]
  );

  // Devices, with names on mine from the sealed device-name list (certificates carry none).
  const namedDevices = useMemo(() => {
    if (!myMember || !devices.has(myMember)) return devices;
    const next = new Map(devices);
    next.set(myMember, devices.get(myMember)!.map((d) => ({ ...d, name: deviceNames.names[d.keyHash] ?? "" })));
    return next;
  }, [devices, myMember, deviceNames]);

  const identity = useMemo<IdentityState | null>(() => {
    if (!base) return null;
    const me = myMember ?? base.keyHash;
    const devicesOf = (m: { keyHash: string; ecdh: string }) =>
      (devices.get(m.keyHash) ?? [{ keyHash: m.keyHash, ecdh: m.ecdh }]).map((d) => ({ keyHash: d.keyHash, publicKey: d.ecdh }));
    const contacts: Contact[] = (directory?.members ?? [])
      .filter((m) => m.keyHash !== me && !departed.has(m.keyHash))
      .map((m) => ({
        keyHash: m.keyHash,
        publicKey: m.ecdh,
        displayName: resolveName(m.keyHash, base.contactSettings) ?? m.keyHash.slice(0, 8),
        volume: base.contactSettings.find((c) => c.keyHash === m.keyHash)?.volume ?? 100,
        devices: devicesOf(m),
      }));
    const myDevices = namedDevices.get(me) ?? [
      { keyHash: base.keyHash, ecdh: base.publicKeyBase64, sig: base.signingPublicKeyBase64, name: "", addedAt: 0, primary: true },
    ];
    return { ...base, keyHash: me, deviceKeyHash: base.keyHash, contacts, myDevices };
  }, [base, myMember, directory, devices, namedDevices, departed, resolveName]);

  const updateSettings = useCallback((keyHash: string, change: Partial<ContactSettings>): BaseIdentity | null => {
    if (!base) return null;
    const existing = base.contactSettings.find((c) => c.keyHash === keyHash) ?? { keyHash, volume: 100 };
    const next = {
      ...base,
      contactSettings: [...base.contactSettings.filter((c) => c.keyHash !== keyHash), { ...existing, ...change }],
      settingsAt: Date.now(),
    };
    setBase(next);
    setSettingsChangedAt(next.settingsAt);
    return next;
  }, [base]);

  const setDisplayName = useCallback(async (keyHash: string, displayName: string): Promise<void> => {
    if (!base) throw new Error("No identity");
    const trimmed = displayName.trim().slice(0, MAX_NAME_LENGTH);
    if (keyHash === (myMember ?? base.keyHash)) {
      if (!trimmed) throw new Error("Enter a name");
      const next = { ...base, myName: trimmed, settingsAt: Date.now() };
      setBase(next);
      setSettingsChangedAt(next.settingsAt);
      // The sealed copies go out from the effect above, now that the name and settingsAt changed.
      await persist(next);
      return;
    }
    const next = updateSettings(keyHash, { nickname: trimmed || undefined });
    if (next) await persist(next);
  }, [base, myMember, updateSettings, persist]);

  const getDisplayName = useCallback(
    (keyHash: string): string | undefined =>
      base && keyHash === (myMember ?? base.keyHash) ? base.myName : resolveName(keyHash, base?.contactSettings ?? []),
    [base, myMember, resolveName]
  );

  const getContactVolume = useCallback(
    (keyHash: string): number => {
      const v = base?.contactSettings.find((c) => c.keyHash === keyHash)?.volume;
      return typeof v === "number" ? Math.min(100, Math.max(0, v)) : 100;
    },
    [base?.contactSettings]
  );

  const setContactVolume = useCallback((keyHash: string, volume: number) => {
    const next = updateSettings(keyHash, { volume: Math.min(100, Math.max(0, Math.round(volume))) });
    if (next) persist(next).catch((e) => setError(e instanceof Error ? e.message : "Failed to save volume"));
  }, [updateSettings, persist]);

  const getMyDisplayName = useCallback((): string => base?.myName || "Me", [base?.myName]);

  const createEnrollmentCode = useCallback(async () => {
    if (!base) throw new Error("No identity");
    return buildEnrollmentCode(base.keyPair.publicKey, base.signingKeyPair, base.myName);
  }, [base]);

  // Folder mode: derived from the passphrase at unlock. App-storage mode: a random non-extractable key in IndexedDB.
  const [cacheKey, setCacheKey] = useState<CryptoKey | null | undefined>(undefined);
  useEffect(() => {
    setCacheKey(undefined);
    if (!base) return;
    const fromFile = fileSessions.current.get(base.server)?.session.cacheKey;
    if (fromFile) return setCacheKey(fromFile);
    let cancelled = false;
    appCacheKey(base.keyHash).then(
      (k) => !cancelled && setCacheKey(k),
      () => !cancelled && setCacheKey(null) // no cache: messages just aren't kept between launches
    );
    return () => {
      cancelled = true;
    };
  }, [base?.keyHash, base?.server]);

  // For the service worker: contacts' device keys and my names for them, so pushes show with my names while the app
  // is closed. App-storage mode only: in folder mode the service worker has no keys, and shows generic notifications.
  useEffect(() => {
    if (!identity || !server || fileSessions.current.has(server.url)) return;
    const peers = identity.contacts.flatMap((c) =>
      c.devices.map((d) => ({ device: d.keyHash, member: c.keyHash, publicKey: d.publicKey, name: c.displayName }))
    );
    savePushPeers(server.url, peers).catch(() => {});
  }, [identity, server]);

  const identityStorage = useMemo<IdentityStorage | null>(() => {
    if (!base) return null;
    const f = fileSessions.current.get(base.server);
    return f ? { kind: "folder", folder: f.ref.dir.name, fileName: f.ref.fileName } : { kind: "app" };
  }, [base]);

  const linkDevice = useCallback(async (code: string, name: string) => {
    if (!base || !myMember) throw new Error("This device isn't a member yet");
    const r = await readEnrollmentCode(code);
    if (!r.ok) throw new Error(r.error);
    if (!name.trim()) throw new Error("Name the device");
    const cert = deviceCert(myMember, r.request, base.signingPublicKeyBase64);
    await postDeviceCert(await signRecord(base.signingKeyPair.privateKey, cert));
    // Its name never goes in the public certificate: it's sealed to my own devices with my profile.
    const names = { at: Date.now(), names: { ...deviceNamesRef.current.names, [r.keyHash]: name.trim().slice(0, MAX_NAME_LENGTH) } };
    setDeviceNames(names);
    writeJson(`${DEVICE_NAMES_KEY}:${base.keyHash}`, names);
    setJustLinked(r.keyHash);
    await refreshDirectory();
    // The new device starts without my nicknames and settings: send them (the chat sends on this bump).
    setSettingsChangedAt(Date.now());
  }, [base, myMember, refreshDirectory]);

  const moveAdmin = useCallback(async (deviceKeyHash: string) => {
    if (!base || !myMember || !directory || !isAdmin) throw new Error("Only the admin device can move admin");
    const target = devices.get(myMember)?.find((d) => d.keyHash === deviceKeyHash);
    if (!target) throw new Error("That isn't one of your devices");
    const admins = (directory.admins ?? [base.signingPublicKeyBase64]).map((a) => (a === base.signingPublicKeyBase64 ? target.sig : a));
    await publishSignedDirectory(directoryWithAdmins(directory, base.signingPublicKeyBase64, admins, Date.now(), devices));
  }, [base, myMember, directory, isAdmin, devices, publishSignedDirectory]);

  const unlinkDevice = useCallback(async (deviceKeyHash: string) => {
    if (!base || !myMember) throw new Error("No identity");
    const sig = devices.get(myMember)?.find((d) => d.keyHash === deviceKeyHash)?.sig;
    if (sig && adminKeys.includes(sig)) throw new Error("That's an admin device. Move admin to another device first.");
    const revoke = deviceRevoke(myMember, deviceKeyHash, base.signingPublicKeyBase64);
    await postDeviceRevoke(await signRecord(base.signingKeyPair.privateKey, revoke));
    // Unlinking this device: it's no longer a member's key, so wipe it here, as when leaving (the server's told).
    if (deviceKeyHash === base.keyHash) await leaveServer({ force: true });
    else await refreshDirectory();
  }, [base, myMember, devices, adminKeys, refreshDirectory, leaveServer]);

  const applyDeviceSync = useCallback((sync: { myName: string; contactSettings: ContactSettings[]; settingsAt: number }) => {
    if (!base || typeof sync.settingsAt !== "number" || sync.settingsAt <= (base.settingsAt ?? 0)) return;
    if (typeof sync.myName !== "string" || !Array.isArray(sync.contactSettings)) return;
    const next = { ...base, myName: sync.myName.slice(0, MAX_NAME_LENGTH), contactSettings: sync.contactSettings, settingsAt: sync.settingsAt };
    setBase(next);
    identities.current.set(next.server, next);
    persist(next).catch(() => {});
  }, [base, persist]);

  const logout = useCallback(() => {
    if (server) {
      clearWallet();
      identities.current.delete(server.url);
      fileSessions.current.delete(server.url);
      if (base) wipeCache(base.keyHash).catch(() => {});
    }
    setBase(null);
  }, [server, base]);

  return (
    <IdentityContext.Provider
      value={{
        identity,
        loading: loading || !serverReady,
        needsSetup,
        lockedFile: locked && !base ? { folder: locked.dir.name, fileName: locked.fileName } : null,
        unlockIdentity,
        openIdentityFolder,
        identityStorage,
        cacheKey,
        linkDevice,
        unlinkDevice,
        applyDeviceSync,
        settingsChangedAt,
        unlinked: !!base && revokedDevices.has(base.keyHash),
        memberDevices: namedDevices,
        justLinked,
        clearJustLinked,
        rememberIntro,
        moveAdmin,
        startOver,
        error,
        dismissError,
        createIdentity,
        directory,
        directoryLoaded,
        directoryError,
        refreshDirectory,
        enrolled,
        isAdmin,
        server,
        joinServer,
        setUpNewServer,
        servers,
        switchServer,
        leaveServer,
        publishSignedDirectory,
        getMember,
        isRemoved,
        setDisplayName,
        getDisplayName,
        getContactVolume,
        setContactVolume,
        getMyDisplayName,
        createEnrollmentCode,
        logout,
      }}
    >
      {children}
    </IdentityContext.Provider>
  );
}

export function useIdentity() {
  const ctx = useContext(IdentityContext);
  if (!ctx) throw new Error("useIdentity must be used within IdentityProvider");
  return ctx;
}
