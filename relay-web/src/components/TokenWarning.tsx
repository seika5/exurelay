"use client";

import { useEffect, useState } from "react";
import { getTokenWarning, subscribeTokenWarning } from "@/lib/tokens";

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
    <div className="fixed top-0 inset-x-0 z-40 bg-amber-600 text-white text-xs px-3 py-2 flex gap-2 items-start" role="alert">
      <span className="flex-1">{warning}</span>
      <button type="button" onClick={() => setDismissed(warning)} className="underline">
        Dismiss
      </button>
    </div>
  );
}
