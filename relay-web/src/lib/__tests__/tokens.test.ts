/**
 * Token key schedule checks, the RFC 9474 blind round trip, join codes and the joined-server list.
 */

import { describe, it, expect, vi } from "vitest";
import { RSABSSA } from "@cloudflare/blindrsa-ts";
import { checkKeySchedule, checkPeerIssuer, DAY_MS, getTokenWarning, setTokenDirectory, type IssuerKey } from "../tokens";
import {
  createJoinCode,
  joinLink,
  listServers,
  loadServerConfig,
  normalizeServerUrl,
  readJoinCode,
  removeServerConfig,
  saveServerConfig,
  serverScopedKey,
  switchServerConfig,
} from "../server";
import { directoryWithAdmins, directoryWithMember, directoryWithoutMember, type Directory } from "../signed";

const MID = Date.UTC(2026, 9, 28);
const daily = (id: string, day = MID): IssuerKey => ({ id, publicKey: "", reason: "daily", notBefore: day, notAfter: day + 2 * DAY_MS });
const dir = (removedAt: number[]): Directory => ({
  type: "relay-directory",
  version: 5,
  issuedAt: MID,
  signer: "a",
  members: [],
  removed: removedAt.map((t, i) => ({ keyHash: `r${i}`, removedAt: t })),
});

describe("issuer key schedule", () => {
  it("accepts one daily key per UTC day", () => {
    const r = checkKeySchedule([daily("a", MID - DAY_MS), daily("b")], null);
    expect(r.accepted.map((k) => k.id)).toEqual(["a", "b"]);
  });

  it("refuses two keys for the same day, off-midnight keys, and a changed key for a day already seen", () => {
    expect(checkKeySchedule([daily("a"), daily("b")], null).accepted).toHaveLength(0);
    expect(checkKeySchedule([{ ...daily("a"), notBefore: MID + 1000, notAfter: MID + 1000 + 2 * DAY_MS }], null).accepted).toHaveLength(0);
    expect(checkKeySchedule([daily("b")], null, { [MID]: "a" }).accepted).toHaveLength(0);
  });

  it("accepts a removal key only with its own removal in the signed member list", () => {
    const t = MID + 5 * 60 * 60 * 1000;
    const removal = (id: string, at: number): IssuerKey => ({ id, publicKey: "", reason: "removal", notBefore: at, notAfter: MID + 2 * DAY_MS, directoryVersion: 5 });
    expect(checkKeySchedule([removal("x", t)], dir([])).accepted).toHaveLength(0);
    expect(checkKeySchedule([removal("x", t)], dir([t - 500])).accepted).toHaveLength(1);
    // One removal can't justify two extra keys.
    const two = checkKeySchedule([removal("x", t), removal("y", t + 60_000)], dir([t - 500]));
    expect(two.accepted.map((k) => k.id)).toEqual(["x"]);
    expect(two.rejected.map((r) => r.key.id)).toEqual(["y"]);
  });
});

describe("blind tokens (RFC 9474)", () => {
  it("round-trips: the signer never sees the token it signs, and the result verifies", async () => {
    const suite = RSABSSA.SHA384.PSS.Randomized();
    const keys = await suite.generateKey({ modulusLength: 2048, publicExponent: Uint8Array.from([1, 0, 1]) });
    const prepared = suite.prepare(crypto.getRandomValues(new Uint8Array(32)));
    const { blindedMsg, inv } = await suite.blind(keys.publicKey, prepared);
    expect(Array.from(blindedMsg)).not.toEqual(Array.from(prepared));
    const blindSig = await suite.blindSign(keys.privateKey, blindedMsg);
    const sig = await suite.finalize(keys.publicKey, prepared, blindSig, inv);
    expect(await suite.verify(keys.publicKey, sig, prepared)).toBe(true);
  }, 20_000);
});

describe("join codes", () => {
  it("round-trips through a code and a link", () => {
    const config = { url: "https://relay.example.com", admins: ["QUJD", "REVG"] };
    const code = createJoinCode(config);
    expect(readJoinCode(code)).toEqual({ ok: true, config });
    expect(readJoinCode(joinLink(code, "https://app.example/"))).toEqual({ ok: true, config });
  });

  it("refuses plain http except for local testing, and damaged codes", () => {
    expect(() => normalizeServerUrl("http://relay.example.com")).toThrow();
    expect(normalizeServerUrl("http://localhost:4000/")).toBe("http://localhost:4000");
    expect(normalizeServerUrl("relay.example.com")).toBe("https://relay.example.com");
    expect(readJoinCode("RELAY-JOIN:nonsense").ok).toBe(false);
    expect(readJoinCode(createJoinCode({ url: "https://x.example", admins: [] })).ok).toBe(false);
  });
});

describe("joined servers", () => {
  it("keeps several servers, switches between them, and migrates the old single-server setting", () => {
    const store = new Map<string, string>();
    globalThis.localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    } as Storage;
    const a = { url: "https://a.example", admins: ["AAAA"] };
    const b = { url: "https://b.example", admins: ["BBBB"] };
    store.set("relay.server", JSON.stringify(a));
    expect(loadServerConfig()).toEqual(a);

    saveServerConfig(b);
    expect(listServers()).toEqual([a, b]);
    expect(loadServerConfig()).toEqual(b);
    expect(serverScopedKey("relay.tokens")).toBe("relay.tokens:https://b.example");
    expect(store.has("relay.server")).toBe(false);

    expect(switchServerConfig(a.url)).toEqual(a);
    expect(serverScopedKey("relay.tokens")).toBe("relay.tokens:https://a.example");
    expect(switchServerConfig("https://unknown.example")).toBeNull();
    expect(loadServerConfig()).toEqual(a);

    // Leaving the active server falls back to the other one; leaving the last leaves none.
    expect(removeServerConfig(a.url)).toEqual(b);
    expect(removeServerConfig(b.url)).toBeNull();
    expect(listServers()).toEqual([]);
  });
});

describe("admins in the directory", () => {
  const m = (n: string) => ({ keyHash: `h${n}`, ecdh: `e${n}`, sig: `s${n}`, enrolledAt: 1 });
  it("starts with the first signer, follows re-enrollment, and keeps at least one admin", () => {
    let d = directoryWithMember(null, "s1", m("1"), 1);
    expect(d.admins).toEqual(["s1"]);
    d = directoryWithMember(d, "s1", m("2"), 2);
    d = directoryWithAdmins(d, "s1", ["s1", "s2"], 3);
    expect(d.admins).toEqual(["s1", "s2"]);
    d = directoryWithMember(d, "s1", { ...m("3"), replaces: "h2" }, 4);
    expect(d.admins).toEqual(["s1", "s3"]);
    d = directoryWithoutMember(d, "s1", "h3", 5);
    expect(d.admins).toEqual(["s1"]);
    expect(() => directoryWithoutMember(d, "s1", "h1", 6)).toThrow(/last admin/);
  });
});

describe("a key newer than our member list", () => {
  const removalAt = Date.now() - 60_000;
  const removal: IssuerKey = {
    id: "0123456789abcdef0123456789abcdef",
    publicKey: "",
    reason: "removal",
    notBefore: removalAt,
    notAfter: Date.UTC(new Date(removalAt).getUTCFullYear(), new Date(removalAt).getUTCMonth(), new Date(removalAt).getUTCDate()) + 2 * DAY_MS,
  };
  const setup = () => {
    const store = new Map<string, string>();
    globalThis.localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    } as Storage;
    saveServerConfig({ url: "https://keys.example", admins: ["AAAA"] });
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ keys: [removal] }))) as typeof fetch;
  };

  it("isn't flagged when the updated member list then shows the removal", async () => {
    setup();
    setTokenDirectory(null);
    await checkPeerIssuer(removal.id);
    expect(getTokenWarning()).toBeNull();
    setTokenDirectory(dir([removalAt - 1000]));
    await vi.waitFor(() => expect(vi.mocked(globalThis.fetch).mock.calls.length).toBeGreaterThanOrEqual(2));
    await new Promise((r) => setTimeout(r, 10));
    expect(getTokenWarning()).toBeNull();
  });

  it("is flagged if a minute passes and nothing explains it", async () => {
    setup();
    vi.useFakeTimers();
    try {
      setTokenDirectory(null);
      // A key the server never published to us.
      await checkPeerIssuer("ffffffffffffffffffffffffffffffff");
      await vi.advanceTimersByTimeAsync(61_000);
      expect(getTokenWarning()).toMatch(/never showed you|breaks the schedule/);
    } finally {
      vi.useRealTimers();
    }
  });
});
