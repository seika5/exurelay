"use client";

import { useIdentity } from "@/context/IdentityContext";

const ADD = "__add__";

/** "relay.example.com" rather than the full URL, which is mostly noise in a menu. */
export function serverLabel(url: string): string {
  try {
    const u = new URL(url);
    return u.host + (u.pathname === "/" ? "" : u.pathname);
  } catch {
    return url;
  }
}

/** Pick which joined server is active. Each server keeps its own tokens and state, so switching is cheap. */
export function ServerSwitcher({ onAdd, className = "" }: { onAdd?: () => void; className?: string }) {
  const { server, servers, switchServer } = useIdentity();
  if (!server || (servers.length < 2 && !onAdd)) return null;
  return (
    <select
      aria-label="Server"
      value={server.url}
      onChange={(e) => {
        if (e.target.value === ADD) onAdd?.();
        else switchServer(e.target.value);
      }}
      className={`min-w-0 px-1.5 py-1 rounded bg-[var(--bg)] border border-[var(--border)] text-xs text-[var(--text)] ${className}`}
    >
      {servers.map((s) => (
        <option key={s.url} value={s.url}>
          {serverLabel(s.url)}
        </option>
      ))}
      {onAdd && <option value={ADD}>+ Join another server…</option>}
    </select>
  );
}
