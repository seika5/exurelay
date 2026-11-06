"use client";

import { useEffect, useState } from "react";
import { disablePush, enablePush, pushState, testPush, type PushState } from "@/lib/push";
import { useIdentity } from "@/context/IdentityContext";
import { btn } from "@/components/ui";
import { InfoTip, SectionTitle } from "@/components/InfoTip";
import { Switch } from "@/components/Modal";
import { appPath } from "@/lib/basePath";

/** Settings → General: push for @mentions and call rings on this device, on or off (DESIGN.md §9). */
export function NotificationsSection() {
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);
  const { identity } = useIdentity();
  useEffect(() => {
    pushState().then(setState, () => setState("unsupported"));
  }, []);

  // Shown instead of the switch when it can't be turned on here.
  const blocked: Partial<Record<PushState, string>> = {
    denied: "Blocked in your browser or phone settings.",
    unsupported: "Not available here. On iPhone, add Exurelay to the Home Screen first.",
    "server-off": "This server doesn't send notifications.",
  };
  const on = state === "on";
  const toggle = async () => {
    setBusy(true);
    setError(null);
    try {
      setState(await (on ? disablePush() : enablePush()));
    } catch (e) {
      setError(e instanceof Error ? e.message : on ? "Couldn't turn off notifications" : "Couldn't turn on notifications");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <SectionTitle tip="Only @mentions and call rings notify you. Nothing else does.">Notifications</SectionTitle>
        {(state === "on" || state === "off") && (
          <span className="flex items-center gap-2">
            {busy && (
              <span
                role="status"
                aria-label={on ? "Turning off notifications" : "Turning on notifications"}
                className="inline-block h-4 w-4 rounded-full border-2 border-[var(--muted)] border-t-transparent animate-spin"
              />
            )}
            <Switch on={on} onChange={toggle} label="Notifications" disabled={busy} />
          </span>
        )}
      </div>
      {state && blocked[state] && <p className="text-xs text-[var(--muted)]">{blocked[state]}</p>}
      {on && identity && (
        <button
          type="button"
          disabled={busy}
          className={`${btn} self-start`}
          onClick={async () => {
            setBusy(true);
            setTestResult(null);
            try {
              setTestResult(await testPush(identity));
            } catch (e) {
              setTestResult(e instanceof Error ? e.message : "Couldn't send a test");
            } finally {
              setBusy(false);
            }
          }}
        >
          Test
        </button>
      )}
      {testResult && <p className="text-xs text-[var(--muted)]">{testResult}</p>}
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
