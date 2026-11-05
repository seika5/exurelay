"use client";

import { useEffect, useRef, useState } from "react";
import { usePlugins } from "@/context/PluginContext";
import { preparePlugin, type StoredPlugin } from "@/lib/plugins";
import { InfoTip, SectionTitle } from "@/components/InfoTip";
import { confirmDialog, Switch } from "@/components/Modal";
import { btn, btnDanger, btnPrimary, field } from "@/components/ui";

/**
 * Settings → Plugins: install from a URL or file (shown with its SHA-256 before you accept), turn on/off, open a
 * plugin's screen, check a URL plugin for updates, remove. Plugins run sandboxed: see src/lib/plugins.ts.
 */
export function PluginsPanel() {
  const { plugins, runtime, errors, install, remove, setEnabled } = usePlugins();
  const [url, setUrl] = useState("");
  const [pending, setPending] = useState<StoredPlugin | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const screen = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    runtime?.show(open, screen.current);
    return () => runtime?.show(open, null);
  }, [open, runtime]);

  const fromUrl = async (u: string, replaces?: StoredPlugin) => {
    setMessage(null);
    try {
      const res = await fetch(u, { cache: "no-store" });
      if (!res.ok) throw new Error(`Couldn't download it (${res.status})`);
      const p = await preparePlugin(await res.text(), new URL(u).pathname.split("/").pop() || "Plugin", u);
      if (replaces && replaces.sha256 === p.sha256) return setMessage(`${replaces.name} is up to date.`);
      setPending(p);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Couldn't download it");
    }
  };

  return (
    <div className="flex flex-col gap-4 text-sm">
      <p className="text-xs text-[var(--muted)] flex items-center gap-1.5">
        Plugins add themes, message types and screens.
        <InfoTip>
          Each runs sandboxed. It can&apos;t see your keys or messages, reach the network, or change how messages are sent, and
          anything it sends needs your OK. Only install plugins from people you trust.
        </InfoTip>
      </p>

      {plugins.length === 0 ? (
        <p className="text-xs text-[var(--muted)]">No plugins yet.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {plugins.map((p) => (
            <li key={p.id} className="flex flex-col gap-1 p-2 rounded border border-[var(--border)]">
              <div className="flex items-center gap-2">
                <span className="font-medium break-words min-w-0 flex-1">{p.name}</span>
                <Switch on={p.enabled} onChange={(on) => setEnabled(p.id, on)} label={p.name} />
              </div>
              <code className="text-[10px] text-[var(--muted)] break-all">sha256 {p.sha256}</code>
              {errors[p.id] && <p className="text-xs text-red-500">Error: {errors[p.id]}</p>}
              <div className="flex gap-2 flex-wrap">
                {p.enabled && (
                  <button type="button" className={btn} onClick={() => setOpen(open === p.id ? null : p.id)}>
                    {open === p.id ? "Close" : "Open"}
                  </button>
                )}
                {p.url && (
                  <button type="button" className={btn} onClick={() => fromUrl(p.url!, p)}>
                    Check for update
                  </button>
                )}
                <button
                  type="button"
                  className={btnDanger}
                  onClick={async () => (await confirmDialog(`Remove ${p.name}?`, { ok: "Remove", danger: true })) && remove(p.id)}
                >
                  Remove
                </button>
              </div>
              {open === p.id && <div ref={screen} className="h-64 rounded border border-[var(--border)] overflow-hidden" />}
            </li>
          ))}
        </ul>
      )}

      {pending ? (
        <div className="flex flex-col gap-2 p-2 rounded border border-amber-400/50">
          <div>
            Install <strong>{pending.name}</strong>?
          </div>
          <code className="text-[10px] break-all">sha256 {pending.sha256}</code>
          <p className="text-xs text-[var(--muted)]">
            Check this hash matches the one its author published. Updates need your OK again.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              className={btnPrimary}
              onClick={async () => {
                const old = plugins.find((x) => x.url && x.url === pending.url);
                if (old && old.id !== pending.id) await remove(old.id);
                await install(pending);
                setPending(null);
                setUrl("");
                setMessage("Installed.");
              }}
            >
              Install
            </button>
            <button type="button" className={btn} onClick={() => setPending(null)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <section className="flex flex-col gap-2">
          <SectionTitle>Install a plugin</SectionTitle>
          <div className="flex items-stretch gap-2">
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://…/plugin.js"
              className={`${field} flex-1 min-w-0`}
            />
            <button type="button" disabled={!url.trim()} className={btn} onClick={() => fromUrl(url.trim())}>
              Get
            </button>
          </div>
          <label className={`${btn} self-start cursor-pointer`}>
            From a file…
            <input
              type="file"
              accept=".js,text/javascript"
              className="sr-only"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (!f) return;
                try {
                  setPending(await preparePlugin(await f.text(), f.name));
                } catch (err) {
                  setMessage(err instanceof Error ? err.message : "Couldn't read it");
                }
              }}
            />
          </label>
        </section>
      )}
      {message && <p className="text-xs text-[var(--muted)]">{message}</p>}
    </div>
  );
}
