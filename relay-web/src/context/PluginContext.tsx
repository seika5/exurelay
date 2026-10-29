"use client";

import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import {
  PluginRuntime,
  THEME_VARS,
  deletePlugin,
  listPlugins,
  savePlugin,
  type StoredPlugin,
} from "@/lib/plugins";

type SendRequest = { plugin: StoredPlugin; messageType: string; data: unknown; fallback: string };

type PluginContextValue = {
  plugins: StoredPlugin[];
  runtime: PluginRuntime | null;
  /** Bumped when plugins start, stop or register types, so rendered messages refresh. */
  version: number;
  errors: Record<string, string>;
  install: (p: StoredPlugin) => Promise<void>;
  remove: (id: string) => Promise<void>;
  setEnabled: (id: string, on: boolean) => Promise<void>;
  /** The chat registers how to send a plugin's message (to the open conversation, after you confirm). */
  setSendHandler: (fn: ((req: SendRequest) => void) | null) => void;
};

const PluginContext = createContext<PluginContextValue | null>(null);

/** Loads enabled plugins and applies what they're allowed to change. */
export function PluginProvider({ children }: { children: React.ReactNode }) {
  const [plugins, setPlugins] = useState<StoredPlugin[]>([]);
  const [runtime, setRuntime] = useState<PluginRuntime | null>(null);
  const [version, setVersion] = useState(0);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const themes = useRef(new Map<string, Record<string, string>>());
  const sendHandler = useRef<((req: SendRequest) => void) | null>(null);

  // Each plugin's colors on top of the app's own.
  const applyThemes = useCallback(() => {
    const root = document.documentElement.style;
    for (const v of THEME_VARS) root.removeProperty(v);
    for (const vars of themes.current.values()) for (const [k, v] of Object.entries(vars)) root.setProperty(k, v);
  }, []);

  useEffect(() => {
    const rt = new PluginRuntime({
      theme: (p, vars) => {
        themes.current.set(p.id, vars);
        applyThemes();
      },
      send: (plugin, req) => sendHandler.current?.({ plugin, ...req }),
      error: (p, e) => setErrors((x) => ({ ...x, [p.id]: e })),
      changed: () => setVersion((v) => v + 1),
    });
    setRuntime(rt);
    listPlugins()
      .then((list) => {
        setPlugins(list);
        list.filter((p) => p.enabled).forEach((p) => rt.start(p));
      })
      .catch(() => {});
    return () => rt.dispose();
  }, [applyThemes]);

  const install = useCallback(async (p: StoredPlugin) => {
    await savePlugin(p);
    setPlugins(await listPlugins());
    if (p.enabled) runtime?.start(p);
  }, [runtime]);

  const stop = useCallback((id: string) => {
    runtime?.stop(id);
    themes.current.delete(id);
    applyThemes();
  }, [runtime, applyThemes]);

  const remove = useCallback(async (id: string) => {
    stop(id);
    await deletePlugin(id);
    setPlugins(await listPlugins());
  }, [stop]);

  const setEnabled = useCallback(async (id: string, on: boolean) => {
    const p = plugins.find((x) => x.id === id);
    if (!p) return;
    const next = { ...p, enabled: on };
    await savePlugin(next);
    setPlugins(await listPlugins());
    if (on) runtime?.start(next);
    if (!on) stop(id);
  }, [plugins, runtime, stop]);

  const setSendHandler = useCallback((fn: ((req: SendRequest) => void) | null) => {
    sendHandler.current = fn;
  }, []);

  return (
    <PluginContext.Provider value={{ plugins, runtime, version, errors, install, remove, setEnabled, setSendHandler }}>
      {children}
    </PluginContext.Provider>
  );
}

export function usePlugins() {
  const ctx = useContext(PluginContext);
  if (!ctx) throw new Error("usePlugins must be used within PluginProvider");
  return ctx;
}
