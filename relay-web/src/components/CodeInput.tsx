"use client";

import { useState } from "react";
import { QrScanner } from "@/components/QrScanner";
import { Icon } from "@/components/icons";
import { btn, btnPrimary } from "@/components/ui";

/**
 * Scan or paste a device's enrollment code. A scanned or pasted code is checked straight away; a typed one (or one
 * whose check failed) gets a "Check code" button.
 */
export function CodeInput({
  value,
  onChange,
  onCheck,
  scanLabel = "Scan code",
  disabled,
}: {
  value: string;
  onChange: (text: string) => void;
  /** Check a code; resolves true if it was good. */
  onCheck: (text: string) => Promise<boolean>;
  scanLabel?: string;
  disabled?: boolean;
}) {
  const [scanning, setScanning] = useState(false);
  const [checking, setChecking] = useState(false);
  const [failed, setFailed] = useState(false);

  const check = async (text: string) => {
    setChecking(true);
    setFailed(false);
    try {
      setFailed(!(await onCheck(text)));
    } catch {
      setFailed(true);
    } finally {
      setChecking(false);
    }
  };

  if (scanning) {
    return (
      <QrScanner
        onClose={() => setScanning(false)}
        onResult={(text) => {
          setScanning(false);
          onChange(text);
          check(text);
        }}
      />
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <button type="button" disabled={disabled} className={`${btnPrimary} self-start`} onClick={() => setScanning(true)}>
        <Icon name="settingsScan" />
        {scanLabel}
      </button>
      <textarea
        value={value}
        onChange={(e) => {
          const next = e.target.value;
          // Many characters at once is a paste (or autofill): check it now. Typing waits for the button.
          const pasted = next.trim().length > 0 && next.length - value.length > 8;
          onChange(next);
          setFailed(false);
          if (pasted) check(next);
        }}
        placeholder="…or paste the code"
        rows={2}
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        className="px-3 py-2 rounded bg-[var(--bg)] border border-[var(--border)] text-xs font-mono break-all"
      />
      {value.trim() && !checking && (
        <button type="button" disabled={disabled} className={`${btn} self-start`} onClick={() => check(value)}>
          {failed ? "Check again" : "Check code"}
        </button>
      )}
    </div>
  );
}
