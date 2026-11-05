"use client";

import { useEffect, useState } from "react";
import { isIOS, isMobileDevice, isStandalone } from "@/lib/platform";
import { appPath } from "@/lib/basePath";
import { InfoTip } from "@/components/InfoTip";

/** Registers the service worker (offline use, push) and, once installed, asks the browser to keep our storage. */
export function ServiceWorkerSetup() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register(appPath("/sw.js"), { scope: appPath("/") }).catch(() => {});
    if (isStandalone()) navigator.storage?.persist?.().catch(() => {});
  }, []);
  return null;
}

/**
 * On a phone, identities are only created inside the installed app: a browser tab and the installed app keep
 * separate storage, so creating one in the tab would leave the installed app without it (DESIGN.md §9).
 * Developers can add ?browser to the URL to skip this.
 */
export function useInstallFirst(): boolean {
  const [need, setNeed] = useState(false);
  useEffect(() => {
    const skip = new URLSearchParams(window.location.search).has("browser");
    setNeed(!skip && isMobileDevice() && !isStandalone());
  }, []);
  return need;
}

export function InstallFirst() {
  const ios = isIOS();
  return (
    <main className="min-h-screen flex flex-col items-center justify-center p-6 gap-4 bg-[var(--bg)] text-[var(--text)]">
      {/* eslint-disable-next-line @next/next/no-img-element -- a static icon; nothing to optimize in a static export */}
      <img src={appPath("/icon-192.png")} alt="" width={72} height={72} className="rounded-2xl" />
      <h1 className="text-xl font-semibold">Install Exurelay first</h1>
      <p className="text-sm text-[var(--muted)] text-center max-w-sm">
        On a phone, Exurelay runs from the Home Screen.{" "}
        <InfoTip>A browser tab and the installed app keep separate storage, so keys made here wouldn&apos;t be in the app.</InfoTip>
      </p>
      <ol className="text-sm list-decimal pl-5 max-w-sm flex flex-col gap-1">
        {ios ? (
          <>
            <li>Tap the Share button in Safari&apos;s toolbar.</li>
            <li>Choose <strong>Add to Home Screen</strong>, then <strong>Add</strong>.</li>
            <li>Open Exurelay from your Home Screen.</li>
          </>
        ) : (
          <>
            <li>Open the browser menu (⋮).</li>
            <li>Choose <strong>Install app</strong> (or <strong>Add to Home screen</strong>).</li>
            <li>Open Exurelay from your Home Screen.</li>
          </>
        )}
      </ol>
      <p className="text-xs text-[var(--muted)] text-center max-w-sm">
        Have a join link? Open it again in the installed app, or paste its code there.
      </p>
    </main>
  );
}
