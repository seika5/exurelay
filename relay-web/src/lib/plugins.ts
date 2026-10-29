/**
 * Plugins (DESIGN.md §9 "Decided: two ways to customize"), API version 1.
 *
 * A plugin is one script, installed from a URL or a file, pinned by its SHA-256 and kept in IndexedDB. It runs in its
 * own sandboxed iframe of public/plugin-host.html: an opaque origin (no access to keys, the cache, cookies or
 * storage) whose CSP allows no network. It talks to the app only over postMessage, and the app checks everything:
 * theme colors are validated, custom message types must be namespaced `x-<name>/<type>` and carry fallback text,
 * rendering is plain text, and every send it asks for needs your OK. Plugins never touch how blobs are sealed or
 * sent.
 */

import { run } from "./keystore";
import { appPath } from "./basePath";

export const PLUGIN_API = 1;
export const PLUGINS = "plugins";

export type StoredPlugin = {
  /** First 16 hex chars of the source's SHA-256. */
  id: string;
  name: string;
  sha256: string;
  source: string;
  url?: string;
  enabled: boolean;
  installedAt: number;
};

export async function sha256Hex(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Name from a `// @relay-plugin name: Something` line near the top, else from the URL or file name. */
export function pluginName(source: string, fallback: string): string {
  const m = source.slice(0, 2000).match(/@relay-plugin\s+name:\s*(.+)/);
  return (m ? m[1] : fallback).trim().slice(0, 64) || "Plugin";
}

export const MAX_PLUGIN_SOURCE = 256 * 1024;

/** A plugin ready to install, with the hash to show the user before they accept it. */
export async function preparePlugin(source: string, fallbackName: string, url?: string): Promise<StoredPlugin> {
  if (source.length > MAX_PLUGIN_SOURCE) throw new Error("That plugin is too big (256 KB at most).");
  const sha256 = await sha256Hex(source);
  return { id: sha256.slice(0, 16), name: pluginName(source, fallbackName), sha256, source, url, enabled: true, installedAt: Date.now() };
}

export const listPlugins = () => run<StoredPlugin[]>("readonly", (s) => s.getAll(), PLUGINS);
export const savePlugin = (p: StoredPlugin) => run("readwrite", (s) => s.put(p), PLUGINS).then(() => undefined);
export const deletePlugin = (id: string) => run("readwrite", (s) => s.delete(id), PLUGINS).then(() => undefined);

// ---------------------------------------------------------------------------
// What plugins may ask for
// ---------------------------------------------------------------------------

/** Theme variables a plugin may set, and what a value may look like (colors only: no url(), no expressions). */
export const THEME_VARS = ["--bg", "--surface", "--border", "--text", "--muted", "--accent"] as const;
const COLOR = /^(#[0-9a-fA-F]{3,8}|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*(0|1|0?\.\d+)\s*)?\))$/;

export function validTheme(vars: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!vars || typeof vars !== "object") return out;
  for (const [k, v] of Object.entries(vars as Record<string, unknown>)) {
    if ((THEME_VARS as readonly string[]).includes(k) && typeof v === "string" && COLOR.test(v.trim())) out[k] = v.trim();
  }
  return out;
}

/** Custom message types are namespaced: `x-<name>/<type>`. */
export const validMessageType = (t: unknown): t is string => typeof t === "string" && /^x-[a-z0-9-]{1,32}\/[a-z0-9-]{1,32}$/.test(t);

export const MAX_PLUGIN_DATA = 16 * 1024;

/** A plugin's send request, checked: a valid type it registered, small JSON data, and fallback text for others. */
export function validSend(
  m: { messageType?: unknown; data?: unknown; fallback?: unknown },
  registered: Set<string>
): { messageType: string; data: unknown; fallback: string } | null {
  if (!validMessageType(m.messageType) || !registered.has(m.messageType)) return null;
  if (typeof m.fallback !== "string" || !m.fallback.trim() || m.fallback.length > 500) return null;
  let json: string;
  try {
    json = JSON.stringify(m.data ?? null);
  } catch {
    return null;
  }
  if (json.length > MAX_PLUGIN_DATA) return null;
  return { messageType: m.messageType, data: JSON.parse(json), fallback: m.fallback.trim() };
}

// ---------------------------------------------------------------------------
// Runtime: one sandboxed iframe per enabled plugin
// ---------------------------------------------------------------------------

export type PluginEvents = {
  theme: (plugin: StoredPlugin, vars: Record<string, string>) => void;
  /** A plugin asks to send a message; the app confirms with the user. */
  send: (plugin: StoredPlugin, req: { messageType: string; data: unknown; fallback: string }) => void;
  error: (plugin: StoredPlugin, error: string) => void;
  changed: () => void;
};

type Running = {
  plugin: StoredPlugin;
  frame: HTMLIFrameElement;
  types: Set<string>;
  beforeSend: boolean;
  ready: boolean;
};

const RENDER_TIMEOUT_MS = 500;

export class PluginRuntime {
  private running = new Map<string, Running>();
  private waiting = new Map<string, (v: string | null) => void>();
  private seq = 0;

  constructor(private events: PluginEvents) {
    window.addEventListener("message", this.onMessage);
  }

  dispose() {
    window.removeEventListener("message", this.onMessage);
    for (const r of this.running.values()) r.frame.remove();
    this.running.clear();
  }

  /** Start a plugin in a fresh sandboxed iframe (hidden until shown as a screen). */
  start(plugin: StoredPlugin) {
    if (this.running.has(plugin.id)) return;
    const frame = document.createElement("iframe");
    // allow-scripts only: an opaque origin, no forms, popups, navigation of the app, or same-origin access.
    frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("title", `Plugin: ${plugin.name}`);
    frame.src = appPath("/plugin-host.html");
    frame.style.cssText = "display:none;border:0;width:100%;height:100%";
    frame.onload = () =>
      frame.contentWindow?.postMessage({ relayHost: PLUGIN_API, type: "load", source: plugin.source, origin: window.location.origin }, "*");
    document.body.appendChild(frame);
    this.running.set(plugin.id, { plugin, frame, types: new Set(), beforeSend: false, ready: false });
  }

  stop(id: string) {
    this.running.get(id)?.frame.remove();
    this.running.delete(id);
    this.events.changed();
  }

  /** The plugin's own screen: its iframe, moved into `container` and shown. */
  show(id: string, container: HTMLElement | null) {
    const r = this.running.get(id);
    if (!r) return;
    if (container) {
      container.appendChild(r.frame);
      r.frame.style.display = "block";
    } else {
      r.frame.style.display = "none";
      document.body.appendChild(r.frame);
    }
  }

  /** Every message type any running plugin can render. */
  types(): Set<string> {
    const out = new Set<string>();
    for (const r of this.running.values()) r.types.forEach((t) => out.add(t));
    return out;
  }

  private request(r: Running, msg: Record<string, unknown>): Promise<string | null> {
    const id = `${++this.seq}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        resolve(null);
      }, RENDER_TIMEOUT_MS);
      this.waiting.set(id, (v) => {
        clearTimeout(timer);
        resolve(v);
      });
      r.frame.contentWindow?.postMessage({ ...msg, id, relayHost: PLUGIN_API }, "*");
    });
  }

  /** Plain text for a custom message from the plugin that registered its type, or null (show the fallback). */
  async render(messageType: string, data: unknown, context: { mine: boolean; sender: string }): Promise<string | null> {
    for (const r of this.running.values()) {
      if (!r.types.has(messageType)) continue;
      const text = await this.request(r, { type: "render", messageType, data, context });
      return text && text.length <= 2000 ? text : null;
    }
    return null;
  }

  /** Let plugins that asked for it change a text before it's sent (each gets the previous one's result). */
  async beforeSend(text: string): Promise<string> {
    let out = text;
    for (const r of this.running.values()) {
      if (!r.beforeSend) continue;
      const next = await this.request(r, { type: "beforeSend", text: out });
      if (typeof next === "string" && next.length <= 10_000) out = next;
    }
    return out;
  }

  /** Read-only: a message shown in the open conversation. */
  notifyMessage(message: { type: string; body?: string; sender: string; mine: boolean }) {
    for (const r of this.running.values()) r.frame.contentWindow?.postMessage({ relayHost: PLUGIN_API, type: "message", message }, "*");
  }

  private onMessage = (event: MessageEvent) => {
    const r = [...this.running.values()].find((x) => x.frame.contentWindow === event.source);
    const m = event.data as Record<string, unknown> | null;
    if (!r || !m || m.relayPlugin !== PLUGIN_API) return;
    switch (m.type) {
      case "ready":
        r.ready = true;
        this.events.changed();
        break;
      case "error":
        this.events.error(r.plugin, String(m.error).slice(0, 300));
        break;
      case "theme":
        this.events.theme(r.plugin, validTheme(m.vars));
        break;
      case "register":
        if (validMessageType(m.messageType)) {
          r.types.add(m.messageType);
          this.events.changed();
        }
        break;
      case "hook":
        if (m.hook === "beforeSend") r.beforeSend = true;
        break;
      case "send": {
        const req = validSend(m, r.types);
        if (req) this.events.send(r.plugin, req);
        break;
      }
      case "rendered":
      case "beforeSendDone": {
        const done = this.waiting.get(String(m.id));
        this.waiting.delete(String(m.id));
        done?.(typeof m.text === "string" ? m.text : null);
        break;
      }
    }
  };
}
