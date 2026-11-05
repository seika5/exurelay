"use client";

import { useEffect, useState } from "react";
import { disablePush, enablePush, pushState, type PushState } from "@/lib/push";
import { InfoTip, SectionTitle } from "@/components/InfoTip";
import { appPath } from "@/lib/basePath";

const button = "self-start px-3 py-1.5 rounded border border-[var(--border)] text-sm disabled:opacity-50";

/** Settings → General: push for @mentions and call rings on this device, on or off (DESIGN.md §9). */
export function NotificationsSection() {
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    pushState().then(setState, () => setState("unsupported"));
  }, []);

  const text: Record<PushState, string> = {
    on: "On for this device.",
    off: "Off.",
    denied: "Blocked in your browser or phone settings.",
    unsupported: "Not available here. On iPhone, add Exurelay to the Home Screen first.",
    "server-off": "This server doesn't send notifications.",
  };
  const change = async (to: () => Promise<PushState>, failed: string) => {
    setBusy(true);
    setError(null);
    try {
      setState(await to());
    } catch (e) {
      setError(e instanceof Error ? e.message : failed);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="flex flex-col gap-2">
      <SectionTitle tip="Only @mentions and call rings notify you. Nothing else does.">Notifications</SectionTitle>
      {state && <p className="text-xs text-[var(--muted)]">{text[state]}</p>}
      {state === "off" && (
        <button type="button" disabled={busy} className={button} onClick={() => change(enablePush, "Couldn't turn on notifications")}>
          Turn on
        </button>
      )}
      {state === "on" && (
        <button type="button" disabled={busy} className={button} onClick={() => change(disablePush, "Couldn't turn off notifications")}>
          Turn off
        </button>
      )}
      {error && <p className="text-xs text-red-500">{error}</p>}
    </section>
  );
}

/** Settings → General, at the bottom: which build this is, to compare with the published one (DESIGN.md §9). */
export function BuildInfo() {
  const [build, setBuild] = useState<{ commit: string; hash: string } | null>(null);
  useEffect(() => {
    fetch(appPath("/build.json"), { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then(setBuild, () => setBuild(null));
  }, []);
  if (!build) return null;
  return (
    <p className="flex items-center gap-1.5 flex-wrap">
      Build <code>{build.hash.slice(0, 16)}</code> · commit <code>{build.commit.slice(0, 12)}</code>
      <InfoTip>The deploy publishes both, so you can check this is the code you expect.</InfoTip>
    </p>
  );
}
