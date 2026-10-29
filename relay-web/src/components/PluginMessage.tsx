"use client";

import { useEffect, useState } from "react";
import { usePlugins } from "@/context/PluginContext";

/** A plugin message: the installed plugin's rendering (plain text), or the sender's fallback text without it. */
export function PluginMessage({ type, data, fallback, mine, sender }: { type: string; data: unknown; fallback: string; mine: boolean; sender: string }) {
  const { runtime, version } = usePlugins();
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setText(null);
    if (runtime?.types().has(type)) runtime.render(type, data, { mine, sender }).then((t) => !cancelled && setText(t));
    return () => {
      cancelled = true;
    };
  }, [runtime, version, type, data, mine, sender]);
  return (
    <span className="whitespace-pre-wrap break-words">
      {text ?? fallback}
      {text === null && <span className="ml-1 text-xs text-[var(--muted)]">({type})</span>}
    </span>
  );
}
