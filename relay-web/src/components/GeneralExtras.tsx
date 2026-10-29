"use client";

import { useEffect, useState } from "react";
import { enablePush, pushState, type PushState } from "@/lib/push";
import { appPath } from "@/lib/basePath";

const button = "self-start px-3 py-1.5 rounded border border-[var(--border)] text-sm disabled:opacity-50";

/** Settings → General: turn on push for @mentions and call rings on this device (DESIGN.md §9). */
export function NotificationsSection() {
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    pushState().then(setState, () => setState("unsupported"));
  }, []);

  const text: Record<PushState, string> = {
    on: "On for this device. You're notified only when someone @mentions you or rings you in a call.",
    off: "Off. Turn on to be notified when someone @mentions you or rings you in a call. Nothing else notifies.",
    denied: "Blocked in your browser or phone settings. Allow notifications for Relay there, then come back.",
    unsupported: "Not available here. On iPhone, install Relay to the Home Screen first (iOS 16.4 or later).",
    "server-off": "This server doesn't send notifications (its admin hasn't set them up).",
  };

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">Notifications</h3>
      {state && <p className="text-xs text-[var(--muted)]">{text[state]}</p>}
      {state === "off" && (
        <button
          type="button"
          disabled={busy}
          className={button}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              setState(await enablePush());
            } catch (e) {
              setError(e instanceof Error ? e.message : "Couldn't turn on notifications");
            } finally {
              setBusy(false);
            }
          }}
        >
          Turn on notifications
        </button>
      )}
      {error && <p className="text-xs text-red-500">{error}</p>}
    </section>
  );
}

/** Settings → General: which build this is, to compare with the published one for its commit (DESIGN.md §9). */
export function BuildInfo() {
  const [build, setBuild] = useState<{ commit: string; hash: string } | null>(null);
  useEffect(() => {
    fetch(appPath("/build.json"), { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then(setBuild, () => setBuild(null));
  }, []);
  if (!build) return null;
  return (
    <section className="flex flex-col gap-1">
      <h3 className="text-sm font-medium">About this app</h3>
      <p className="text-xs text-[var(--muted)]">
        Build <code>{build.hash.slice(0, 16)}</code> from commit <code>{build.commit.slice(0, 12)}</code>. The deploy
        publishes both, so you can check this is the code you expect.
      </p>
    </section>
  );
}
