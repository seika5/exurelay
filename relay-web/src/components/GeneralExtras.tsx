"use client";

import { useEffect, useState } from "react";
import { disablePush, enablePush, notifyAllState, pushState, setNotifyAll, type PushState } from "@/lib/push";
import { notifyAllAllowed } from "@/lib/signed";
import { useIdentity } from "@/context/IdentityContext";
import { InfoTip, SectionTitle } from "@/components/InfoTip";
import { Switch } from "@/components/Modal";
import { appPath } from "@/lib/basePath";

/** Settings → General: push for @mentions and call rings on this device, and every message if the admin allows (DESIGN.md §9). */
export function NotificationsSection() {
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { identity, directory } = useIdentity();
  const device = identity?.deviceKeyHash;
  const [all, setAll] = useState(false);
  const [allBusy, setAllBusy] = useState(false);
  useEffect(() => {
    if (device) pushState(device).then(setState, () => setState("unsupported"));
  }, [device]);
  // Every-message notifications ride on this device's subscription: turning notifications off drops them too.
  useEffect(() => {
    if (device && state === "on") notifyAllState(device).then(setAll, () => setAll(false));
    else setAll(false);
  }, [device, state]);
  const allowed = notifyAllAllowed(directory);

  // Shown instead of the switch when it can't be turned on here.
  const blocked: Partial<Record<PushState, string>> = {
    denied: "Blocked. Allow notifications for this site in your browser or phone settings, then reload.",
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
        <SectionTitle tip="@mentions and call rings notify you. Turn on Every message for the rest.">Notifications</SectionTitle>
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
        {/* Still checking: hold the switch's place (so nothing below moves when it appears), with a spinner. */}
        {state === null && (
          <span className="flex h-6 w-11 touch:my-2 items-center justify-end" role="status" aria-label="Checking notifications">
            <span className="inline-block h-4 w-4 rounded-full border-2 border-[var(--muted)] border-t-transparent animate-spin" />
          </span>
        )}
      </div>
      {state && blocked[state] && <p className="text-xs text-[var(--muted)]">{blocked[state]}</p>}
      {state !== "unsupported" && state !== "server-off" && (
        <div className={`flex items-center justify-between gap-3 ${on && allowed ? "" : "opacity-50"}`}>
          <span className="text-sm flex items-center gap-1.5">
            Every message
            <InfoTip>
              {allowed
                ? "Also notify for every message and when a call starts. The server then sees, as it happens, who is messaging you."
                : "Turned off for this server by its admin."}
            </InfoTip>
          </span>
          <Switch
            on={on && allowed && all}
            label="Notify for every message"
            disabled={!on || !allowed || allBusy}
            onChange={async (next) => {
              setAllBusy(true);
              setError(null);
              try {
                await setNotifyAll(next);
                setAll(next);
              } catch (e) {
                setError(e instanceof Error ? e.message : "Couldn't change that");
              } finally {
                setAllBusy(false);
              }
            }}
          />
        </div>
      )}
      {error && <p className="text-xs text-red-500">{error}</p>}
    </section>
  );
}

/** Settings → General, at the bottom: which build this is, to compare with the published one (DESIGN.md §9). */
export function BuildInfo() {
  // undefined while loading, null if it couldn't be read.
  const [build, setBuild] = useState<{ commit: string; hash: string } | null | undefined>(undefined);
  useEffect(() => {
    fetch(appPath("/build.json"), { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then(setBuild, () => setBuild(null));
  }, []);
  // Until it loads, an invisible line of the same size holds its place, so the lines above don't jump when it appears.
  if (build === null) return null;
  return (
    <p className={`flex items-center gap-1.5 flex-wrap ${build ? "" : "invisible"}`} aria-hidden={!build}>
      Build <code>{build ? build.hash.slice(0, 16) : "0000000000000000"}</code> · commit <code>{build ? build.commit.slice(0, 12) : "000000000000"}</code>
      <InfoTip>The deploy publishes both, so you can check this is the code you expect.</InfoTip>
    </p>
  );
}
