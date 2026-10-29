"use client";

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { exportPrivateKey, exportPublicKey, generateKeyPair, generateSigningKeyPair, importIdentityKeys } from "@/lib/crypto";
import { createIdentityFile, openIdentityFile, rewriteSettings, type FileSession } from "@/lib/identityFile";
import { getKeyHashFromKeyPair } from "@/lib/e2ee";
import { ApiError, getDirectory, postLeave, publishDirectory, publishProfile } from "@/lib/api";
import {
  deleteFolderRef,
  deleteIdentity,
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
  MAX_NAME_LENGTH,
  signRecord,
  verifyDepartures,
  verifyDirectory,
  verifyProfiles,
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
import { clearWallet, resetWalletMemory, setTokenDirectory } from "@/lib/tokens";

/** Newest directory version this device has accepted for the current server (rollback protection). */
const DIRECTORY_VERSION_KEY = "relay.directoryVersion";
const DIRECTORY_POLL_MS = 60_000;

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
  /** Active directory members other than me, with resolved names. Derived from the verified directory. */
  contacts: Contact[];
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
  error: string | null;
  dismissError: () => void;
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
  publishSignedDirectory: (next: Directory) => Promise<void>;
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

type BaseIdentity = Omit<IdentityState, "contacts">;

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
  const [directoryLoaded, setDirectoryLoaded] = useState(false);
  const [directoryError, setDirectoryError] = useState<string | null>(null);
  const profilePublishedFor = useRef<string | null>(null);

  const [server, setServer] = useState<ServerConfig | null>(null);
  const [servers, setServers] = useState<ServerConfig[]>([]);
  const [serverReady, setServerReady] = useState(false);
  const adminKeys = useMemo(() => server?.admins ?? [], [server]);

  // Server choice: a #join= link wins over a saved choice; otherwise saved, otherwise the build's preset.
  useEffect(() => {
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
        window.confirm(
          known
            ? `This link trusts different admins for ${joined.config.url} than you have now. Replace them?`
            : `Join ${joined.config.url}? You'll stay a member of your other servers.`
        ))
    ) {
      saveServerConfig(joined.config);
      setServer(joined.config);
    } else {
      setServer(saved);
    }
    setServers(listServers());
    setServerReady(true);
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
      const bytes = await rewriteSettings(f.session, { myName: next.myName, contactSettings: next.contactSettings });
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
    const trimmed = name.trim().slice(0, MAX_NAME_LENGTH);
    if (!trimmed) throw new Error("Enter a name");
    const folder = storage.kind === "folder";
    // Folder mode: extractable only long enough to write the encrypted file, then re-imported non-extractable.
    const ecdh = await generateKeyPair(folder);
    const signing = await generateSigningKeyPair(folder);
    const publicKeyBase64 = await exportPublicKey(ecdh.publicKey);
    const signingPublicKeyBase64 = await exportPublicKey(signing.publicKey);
    let keys = { keyPair: ecdh, signingKeyPair: signing };
    if (storage.kind === "folder") {
      const fileName = identityFileName(serverUrl);
      if (!(await ensureFolderAccess(storage.dir))) throw new Error("Relay needs access to that folder to save your identity.");
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
    if (!(await ensureFolderAccess(locked.dir))) throw new Error("Relay needs access to the folder to read your identity.");
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
      setProfiles(await verifyProfiles(res.profiles ?? [], result.directory.members));
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

  useEffect(() => {
    if (!base || !server) return;
    refreshDirectory();
    const timer = setInterval(refreshDirectory, DIRECTORY_POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") refreshDirectory();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [base, server, refreshDirectory]);

  const enrolled = !!base && !!directory?.members.some((m) => m.keyHash === base.keyHash);
  const isAdmin = !!base && adminKeys.includes(base.signingPublicKeyBase64);

  const leaveServer = useCallback(async ({ force = false }: { force?: boolean } = {}) => {
    if (!server) return;
    if (base && enrolled && !force) {
      const env = await signRecord(base.signingKeyPair.privateKey, {
        type: "relay-leave",
        keyHash: base.keyHash,
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
    clearWallet();
    try {
      localStorage.removeItem(serverScopedKey(DIRECTORY_VERSION_KEY));
    } catch {
      // ignore
    }
    identities.current.delete(server.url);
    // The identity file goes too once we've left (it's useless after); while locked we couldn't sign the leave,
    // so the file stays and only this device forgets the server.
    const file = fileSessions.current.get(server.url)?.ref ?? (await loadFolderRef(server.url).catch(() => null));
    if (file) {
      if (base) {
        try {
          if (await ensureFolderAccess(file.dir)) await removeFolderFile(file.dir, file.fileName);
        } catch {
          // Couldn't delete it: it's no longer a member's key either way.
        }
      }
      await deleteFolderRef(server.url).catch(() => {});
    }
    fileSessions.current.delete(server.url);
    await deleteIdentity(server.url);
    setBase(null);
    setLocked(null);
    activate(removeServerConfig(server.url));
  }, [server, base, enrolled, activate]);

  const signAndPublishProfile = useCallback(async (identity: BaseIdentity, name: string) => {
    const env = await signRecord(identity.signingKeyPair.privateKey, {
      type: "relay-profile",
      keyHash: identity.keyHash,
      name,
      updatedAt: Date.now(),
    });
    await publishProfile(env);
  }, []);

  // Once enrolled, publish my display name if the directory doesn't have it yet.
  useEffect(() => {
    if (!base || !enrolled || !directoryLoaded) return;
    if (profiles.get(base.keyHash)?.name === base.myName) return;
    if (profilePublishedFor.current === base.myName) return;
    profilePublishedFor.current = base.myName;
    signAndPublishProfile(base, base.myName)
      .then(refreshDirectory)
      .catch(() => {
        profilePublishedFor.current = null;
      });
  }, [base, enrolled, directoryLoaded, profiles, signAndPublishProfile, refreshDirectory]);

  const publishSignedDirectory = useCallback(async (next: Directory) => {
    if (!base || !isAdmin) throw new Error("Only an admin can change the member list");
    if (next.signer !== base.signingPublicKeyBase64) throw new Error("Directory signer must be this admin");
    await publishDirectory(await signRecord(base.signingKeyPair.privateKey, next));
    await refreshDirectory();
  }, [base, isAdmin, refreshDirectory]);

  // Admin: drop members who left from the signed list, so everyone's directory catches up.
  const cleaningUp = useRef(false);
  useEffect(() => {
    if (!base || !isAdmin || !directory || departed.size === 0 || cleaningUp.current) return;
    cleaningUp.current = true;
    publishSignedDirectory(directoryWithoutMembers(directory, base.signingPublicKeyBase64, [...departed]))
      .catch(() => {})
      .finally(() => {
        cleaningUp.current = false;
      });
  }, [base, isAdmin, directory, departed, publishSignedDirectory]);

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

  const identity = useMemo<IdentityState | null>(() => {
    if (!base) return null;
    const contacts: Contact[] = (directory?.members ?? [])
      .filter((m) => m.keyHash !== base.keyHash && !departed.has(m.keyHash))
      .map((m) => ({
        keyHash: m.keyHash,
        publicKey: m.ecdh,
        displayName: resolveName(m.keyHash, base.contactSettings) ?? m.keyHash.slice(0, 8),
        volume: base.contactSettings.find((c) => c.keyHash === m.keyHash)?.volume ?? 100,
      }));
    return { ...base, contacts };
  }, [base, directory, departed, resolveName]);

  const updateSettings = useCallback((keyHash: string, change: Partial<ContactSettings>): BaseIdentity | null => {
    if (!base) return null;
    const existing = base.contactSettings.find((c) => c.keyHash === keyHash) ?? { keyHash, volume: 100 };
    const next = {
      ...base,
      contactSettings: [...base.contactSettings.filter((c) => c.keyHash !== keyHash), { ...existing, ...change }],
    };
    setBase(next);
    return next;
  }, [base]);

  const setDisplayName = useCallback(async (keyHash: string, displayName: string): Promise<void> => {
    if (!base) throw new Error("No identity");
    const trimmed = displayName.trim().slice(0, MAX_NAME_LENGTH);
    if (keyHash === base.keyHash) {
      if (!trimmed) throw new Error("Enter a name");
      const next = { ...base, myName: trimmed };
      setBase(next);
      profilePublishedFor.current = trimmed;
      await persist(next);
      if (enrolled) {
        await signAndPublishProfile(next, trimmed);
        await refreshDirectory();
      }
      return;
    }
    const next = updateSettings(keyHash, { nickname: trimmed || undefined });
    if (next) await persist(next);
  }, [base, enrolled, signAndPublishProfile, refreshDirectory, updateSettings, persist]);

  const getDisplayName = useCallback(
    (keyHash: string): string | undefined =>
      base && keyHash === base.keyHash ? base.myName : resolveName(keyHash, base?.contactSettings ?? []),
    [base, resolveName]
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

  const identityStorage = useMemo<IdentityStorage | null>(() => {
    if (!base) return null;
    const f = fileSessions.current.get(base.server);
    return f ? { kind: "folder", folder: f.ref.dir.name, fileName: f.ref.fileName } : { kind: "app" };
  }, [base]);

  const logout = useCallback(() => {
    if (server) {
      clearWallet();
      identities.current.delete(server.url);
      fileSessions.current.delete(server.url);
    }
    setBase(null);
  }, [server]);

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
