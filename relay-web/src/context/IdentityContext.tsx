"use client";

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { Filesystem, Directory as FsDirectory } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";
import {
  importKeyPair,
  exportPrivateKey,
  exportPublicKey,
  generateKeyPair,
  generateSigningKeyPair,
  importSigningKeyPair,
} from "@/lib/crypto";
import { getKeyHashFromKeyPair } from "@/lib/e2ee";
import { ApiError, getDirectory, postLeave, publishDirectory, publishProfile } from "@/lib/api";
import {
  parseIdentityBinary,
  writeIdentityBinary,
  type Contact,
  type ContactSettings,
} from "@/lib/identityBinary";
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
  identityFileId,
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

const IS_NATIVE = Capacitor.isNativePlatform();

/**
 * One identity per server, so servers can't link a member across servers by key. Each lives in its own file,
 * named by a hash of the server URL; the file also records its server, so a file can't be used for the wrong one.
 */
/** Identity file in the app Documents directory (native only). */
const nativeIdentityFile = (id: string) => `identity-${id}.bin`;
/** Identity served statically (web only). */
const webIdentityPath = (id: string) => `/identity/${id}.bin`;
/** Web API route for auto-save (web only, localhost-gated). */
const IDENTITY_API_PATH = "/api/identity";
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

type IdentityContextValue = {
  identity: IdentityState | null;
  /** True until the initial identity load has completed. */
  loading: boolean;
  /** No identity for the active server on this device yet: show the create-identity screen. */
  needsSetup: boolean;
  error: string | null;
  dismissError: () => void;
  createIdentity: (name: string) => Promise<void>;
  loadIdentityFromBytes: (buffer: ArrayBuffer, serverUrl: string) => Promise<void>;
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
  setUpNewServer: (url: string, name: string) => Promise<void>;
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
  /**
   * Web: downloads identity.bin via browser anchor.
   * Native: saves to Documents directory and opens the iOS share sheet.
   */
  saveIdentityBinary: () => Promise<void>;
  logout: () => void;
};

const IdentityContext = createContext<IdentityContextValue | null>(null);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build the raw identity bytes from the current in-memory state. */
async function buildIdentityBytes(identity: IdentityState): Promise<Uint8Array> {
  return writeIdentityBinary({
    server: identity.server,
    publicKeyBase64: identity.publicKeyBase64,
    privateKeyJwk: await exportPrivateKey(identity.keyPair.privateKey),
    signingPublicKeyBase64: identity.signingPublicKeyBase64,
    signingPrivateKeyJwk: await exportPrivateKey(identity.signingKeyPair.privateKey),
    myName: identity.myName,
    contactSettings: identity.contactSettings,
  });
}

/**
 * Persist identity to disk. Returns false if it couldn't be saved (web app not served from localhost).
 * Native: writes to the app Documents directory via @capacitor/filesystem.
 * Web:    PUTs to /api/identity (localhost-only).
 */
async function persistIdentityBinary(identity: IdentityState): Promise<boolean> {
  const bytes = await buildIdentityBytes(identity);
  const id = await identityFileId(identity.server);

  if (IS_NATIVE) {
    const base64 = btoa(String.fromCharCode(...Array.from(bytes)));
    await Filesystem.writeFile({
      path: nativeIdentityFile(id),
      data: base64,
      directory: FsDirectory.Documents,
    });
    return true;
  }

  try {
    const res = await fetch(`${IDENTITY_API_PATH}?id=${id}`, {
      method: "PUT",
      body: bytes.buffer as ArrayBuffer,
      headers: { "Content-Type": "application/octet-stream" },
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Delete a server's identity file (when leaving it). Best effort: a leftover file is no longer a member. */
async function deleteIdentityFile(serverUrl: string): Promise<void> {
  const id = await identityFileId(serverUrl);
  try {
    if (IS_NATIVE) {
      await Filesystem.deleteFile({ path: nativeIdentityFile(id), directory: FsDirectory.Documents });
    } else {
      await fetch(`${IDENTITY_API_PATH}?id=${id}`, { method: "DELETE" });
    }
  } catch {
    // Already gone, or nowhere it could have been saved.
  }
}

function downloadBytes(bytes: Uint8Array, filename: string) {
  const blob = new Blob([bytes.buffer as ArrayBuffer], { type: "application/octet-stream" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

/** Convert a base64 string (from Filesystem.readFile on native) to an ArrayBuffer. */
function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer as ArrayBuffer;
}

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
// Native identity scan
// ---------------------------------------------------------------------------

/**
 * Load this server's identity from the app Documents directory. If its own file isn't there, look for a .bin file
 * the user dragged in that belongs to this server, and rename it for subsequent launches. Null if there's none.
 */
async function loadNativeIdentity(serverUrl: string): Promise<ArrayBuffer | null> {
  const path = nativeIdentityFile(await identityFileId(serverUrl));
  try {
    const result = await Filesystem.readFile({ path, directory: FsDirectory.Documents });
    const buf = base64ToArrayBuffer(result.data as string);
    if (buf.byteLength > 0) return buf;
  } catch {
    // Not present yet — fall through to scan.
  }

  const dir = await Filesystem.readdir({ path: "", directory: FsDirectory.Documents });
  for (const f of dir.files.filter((f) => f.name.endsWith(".bin") && f.name !== path)) {
    try {
      const result = await Filesystem.readFile({ path: f.name, directory: FsDirectory.Documents });
      const buf = base64ToArrayBuffer(result.data as string);
      if (parseIdentityBinary(buf).server !== serverUrl) continue;
      await Filesystem.rename({ from: f.name, to: path, directory: FsDirectory.Documents });
      return buf;
    } catch {
      // Not an identity file (or an old one): skip it.
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

type BaseIdentity = Omit<IdentityState, "contacts">;

export function IdentityProvider({ children }: { children: React.ReactNode }) {
  const [base, setBase] = useState<BaseIdentity | null>(null);
  const [loading, setLoading] = useState(true);
  const [needsSetup, setNeedsSetup] = useState(false);
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

  const adopt = useCallback(async (next: BaseIdentity, save: boolean) => {
    identities.current.set(next.server, next);
    if (next.server === activeUrl.current) {
      setBase(next);
      setNeedsSetup(false);
    }
    if (save && !(await persistIdentityBinary(next as IdentityState))) {
      // Not on localhost: nowhere to save it automatically, so hand the file to the user.
      const id = await identityFileId(next.server);
      downloadBytes(await buildIdentityBytes(next as IdentityState), `${id}.bin`);
      setError(
        `Couldn't save your identity automatically, so it was downloaded instead.\n\nPut ${id}.bin in relay-web/public/identity/ or you'll lose this account when the page reloads.`
      );
    }
  }, []);

  const loadIdentityFromBytes = useCallback(async (buffer: ArrayBuffer, serverUrl: string) => {
    setError(null);
    try {
      const data = parseIdentityBinary(buffer);
      if (data.server !== serverUrl) throw new Error(`This identity file belongs to ${data.server}, not ${serverUrl}.`);
      const keyPair = await importKeyPair(data.privateKeyJwk, data.publicKeyBase64);
      const signingKeyPair = await importSigningKeyPair(data.signingPrivateKeyJwk, data.signingPublicKeyBase64);
      await adopt(
        {
          server: data.server,
          keyPair,
          signingKeyPair,
          keyHash: await getKeyHashFromKeyPair(keyPair),
          publicKeyBase64: data.publicKeyBase64,
          signingPublicKeyBase64: data.signingPublicKeyBase64,
          myName: data.myName,
          contactSettings: data.contactSettings,
        },
        IS_NATIVE
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
      throw e;
    }
  }, [adopt]);

  const newIdentity = async (serverUrl: string, name: string): Promise<BaseIdentity> => {
    const trimmed = name.trim().slice(0, MAX_NAME_LENGTH);
    if (!trimmed) throw new Error("Enter a name");
    const keyPair = await generateKeyPair();
    const signingKeyPair = await generateSigningKeyPair();
    return {
      server: serverUrl,
      keyPair,
      signingKeyPair,
      keyHash: await getKeyHashFromKeyPair(keyPair),
      publicKeyBase64: await exportPublicKey(keyPair.publicKey),
      signingPublicKeyBase64: await exportPublicKey(signingKeyPair.publicKey),
      myName: trimmed,
      contactSettings: [],
    };
  };

  /** A new identity for the active server. */
  const createIdentity = useCallback(async (name: string) => {
    setError(null);
    if (!server) throw new Error("Join a server first");
    await adopt(await newIdentity(server.url, name), true);
  }, [server, adopt]);

  const dismissError = useCallback(() => setError(null), []);

  // Load the active server's identity whenever the server changes. A missing file means "create one", not an error.
  useEffect(() => {
    if (!serverReady) return;
    activeUrl.current = server?.url ?? null;
    setError(null);
    setNeedsSetup(false);
    const url = server?.url;
    const cached = url ? identities.current.get(url) : undefined;
    setBase(cached ?? null);
    if (!url || cached) {
      setLoading(false);
      return;
    }
    setLoading(true);
    let cancelled = false;
    const load = IS_NATIVE
      ? loadNativeIdentity(url).catch(() => null)
      : identityFileId(url)
          .then((id) => fetch(webIdentityPath(id), { cache: "no-store" }))
          .then((r) => (r.ok ? r.arrayBuffer() : null))
          .catch(() => null);
    load
      .then(async (buf) => {
        if (cancelled) return;
        if (buf && buf.byteLength > 0) await loadIdentityFromBytes(buf, url).catch(() => {});
        else setNeedsSetup(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [serverReady, server?.url, loadIdentityFromBytes]);

  /** First admin of a brand-new server: a new identity for it, whose signing key is pinned as the admin. */
  const setUpNewServer = useCallback(async (url: string, name: string) => {
    const normalized = normalizeServerUrl(url);
    const next = await newIdentity(normalized, name);
    const config: ServerConfig = { url: normalized, admins: [next.signingPublicKeyBase64] };
    identities.current.set(normalized, next);
    saveServerConfig(config);
    activate(config);
    await adopt(next, true);
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
    await deleteIdentityFile(server.url);
    setBase(null);
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
      await persistIdentityBinary(next as IdentityState);
      if (enrolled) {
        await signAndPublishProfile(next, trimmed);
        await refreshDirectory();
      }
      return;
    }
    const next = updateSettings(keyHash, { nickname: trimmed || undefined });
    if (next) await persistIdentityBinary(next as IdentityState);
  }, [base, enrolled, signAndPublishProfile, refreshDirectory, updateSettings]);

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
    if (next) persistIdentityBinary(next as IdentityState).catch((e) => setError(e instanceof Error ? e.message : "Failed to save volume"));
  }, [updateSettings]);

  const getMyDisplayName = useCallback((): string => base?.myName || "Me", [base?.myName]);

  const createEnrollmentCode = useCallback(async () => {
    if (!base) throw new Error("No identity");
    return buildEnrollmentCode(base.keyPair.publicKey, base.signingKeyPair, base.myName);
  }, [base]);

  const saveIdentityBinary = useCallback(async (): Promise<void> => {
    if (!identity) throw new Error("No identity loaded");
    const bytes = await buildIdentityBytes(identity);
    const file = nativeIdentityFile(await identityFileId(identity.server));

    if (IS_NATIVE) {
      const base64 = btoa(String.fromCharCode(...Array.from(bytes)));
      const writeResult = await Filesystem.writeFile({
        path: file,
        data: base64,
        directory: FsDirectory.Documents,
      });
      await Share.share({
        title: file,
        text: "Relay identity file",
        url: writeResult.uri,
      });
      return;
    }

    // Named as relay-web/public/identity/ expects it.
    downloadBytes(bytes, `${await identityFileId(identity.server)}.bin`);
  }, [identity]);

  const logout = useCallback(() => {
    if (server) {
      clearWallet();
      identities.current.delete(server.url);
    }
    setBase(null);
  }, [server]);

  return (
    <IdentityContext.Provider
      value={{
        identity,
        loading: loading || !serverReady,
        needsSetup,
        error,
        dismissError,
        createIdentity,
        loadIdentityFromBytes,
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
        saveIdentityBinary,
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
