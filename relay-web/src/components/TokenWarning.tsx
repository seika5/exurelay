"use client";

import { useEffect, useState } from "react";
import { getTokenWarning, subscribeTokenWarning } from "@/lib/tokens";
import { Icon } from "@/components/icons";

/** Banner for problems the token wallet found: a server that may be tagging members. */
export function TokenWarning() {
  const [warning, setWarning] = useState(getTokenWarning());
  const [dismissed, setDismissed] = useState<string | null>(null);
  useEffect(() => {
    const unsubscribe = subscribeTokenWarning(() => setWarning(getTokenWarning()));
    return () => {
      unsubscribe();
    };
  }, []);
  if (!warning || dismissed === warning) return null;
  return (
    <div
      className="fixed top-0 inset-x-0 z-40 bg-amber-600 text-white text-xs px-3 pb-2 flex gap-2 items-start"
      style={{ paddingTop: "max(0.5rem, env(safe-area-inset-top, 0px))" }}
      role="alert"
    >
      <span className="flex-1 self-center">{warning}</span>
      <button
        type="button"
        onClick={() => setDismissed(warning)}
        aria-label="Dismiss"
        title="Dismiss"
        className="inline-flex shrink-0 items-center justify-center w-8 h-8 touch:w-10 touch:h-10 rounded border border-white/60 hover:bg-white/10"
      >
        <Icon name="close" />
      </button>
    </div>
  );
}
