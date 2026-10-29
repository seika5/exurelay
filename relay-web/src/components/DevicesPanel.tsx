"use client";

import { useEffect, useState } from "react";
import { useIdentity } from "@/context/IdentityContext";
import { QrScanner } from "@/components/QrScanner";
import { fingerprint, readEnrollmentCode } from "@/lib/signed";

const button = "px-3 py-1.5 rounded border border-[var(--border)] text-sm disabled:opacity-50";

/**
 * Settings → Devices (DESIGN.md §4 "Decided: linked devices"): my devices, linking a new one from its enrollment
 * code, and unlinking. Each device has its own keys; any of mine can link or unlink the others, with no admin.
 */
export function DevicesPanel() {
  const { identity, linkDevice, unlinkDevice, moveAdmin, isAdmin, directory } = useIdentity();
  const [code, setCode] = useState("");
  const [scanning, setScanning] = useState(false);
  const [checked, setChecked] = useState<{ fp: string } | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [fps, setFps] = useState<Record<string, string>>({});

  useEffect(() => {
    identity?.myDevices.forEach((d) => fingerprint(d.ecdh).then((fp) => setFps((m) => ({ ...m, [d.keyHash]: fp }))));
  }, [identity?.myDevices]);

  if (!identity) return null;
  const adminSigs = directory?.admins ?? [];

  const check = async (text: string) => {
    setMessage(null);
    setChecked(null);
    const r = await readEnrollmentCode(text);
    if (!r.ok) return setMessage(r.error);
    if (identity.myDevices.some((d) => d.keyHash === r.keyHash)) return setMessage("That device is already linked.");
    setCode(text);
    setChecked({ fp: await fingerprint(r.request.ecdh) });
  };

  const run = async (fn: () => Promise<void>, done: string) => {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
      setMessage(done);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4 text-sm">
      <section className="flex flex-col gap-2">
        <h3 className="font-medium">Your devices</h3>
        <ul className="flex flex-col gap-1.5">
          {identity.myDevices.map((d) => {
            const isThis = d.keyHash === identity.deviceKeyHash;
            const isAdminDevice = adminSigs.includes(d.sig);
            return (
              <li key={d.keyHash} className="flex items-center gap-2 px-2 py-1.5 rounded border border-[var(--border)]">
                <div className="flex-1 min-w-0">
                  <div className="truncate">
                    {d.primary ? "Enrolled device" : d.name || "Device"}
                    {isThis && <span className="ml-2 text-xs text-[var(--accent)]">this device</span>}
                    {isAdminDevice && <span className="ml-2 text-xs text-amber-300">admin device</span>}
                  </div>
                  <code className="text-xs text-[var(--muted)]">{fps[d.keyHash] ?? ""}</code>
                </div>
                {isAdmin && !isAdminDevice && (
                  <button
                    type="button"
                    disabled={busy}
                    className={button}
                    onClick={() => {
                      if (window.confirm(`Make "${d.primary ? "Enrolled device" : d.name || "this device"}" your admin device? This device stops being one.`)) {
                        run(() => moveAdmin(d.keyHash), "Admin moved.");
                      }
                    }}
                  >
                    Make admin device
                  </button>
                )}
                {!d.primary && !isAdminDevice && (
                  <button
                    type="button"
                    disabled={busy}
                    className={button}
                    onClick={() => {
                      const text = isThis
                        ? "Unlink this device? It stops being part of your account and its keys and messages here are deleted."
                        : `Unlink "${d.name || "this device"}"? It can no longer read or send as you.`;
                      if (window.confirm(text)) run(() => unlinkDevice(d.keyHash), "Unlinked.");
                    }}
                  >
                    Unlink
                  </button>
                )}
              </li>
            );
          })}
        </ul>
        <p className="text-xs text-[var(--muted)]">
          Each device has its own keys. Lost one? Unlink it here; nobody has to check your key again. The enrolled
          device can only be replaced by the admin (or by leaving the server).
          {isAdmin && " Admin works from one device at a time: the admin device. Move it before unlinking that device."}
        </p>
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="font-medium">Link a device</h3>
        <p className="text-xs text-[var(--muted)]">
          On the new device, join this server and create an identity. Its waiting screen shows a code: scan or paste it
          here, and check the fingerprint matches.
        </p>
        {scanning ? (
          <QrScanner
            onClose={() => setScanning(false)}
            onResult={(text) => {
              setScanning(false);
              check(text);
            }}
          />
        ) : (
          <div className="flex flex-col gap-2">
            <button type="button" className={`${button} self-start`} onClick={() => setScanning(true)}>
              Scan its code
            </button>
            <textarea
              value={code}
              onChange={(e) => {
                setCode(e.target.value);
                setChecked(null);
              }}
              placeholder="…or paste its code (RELAY-ENROLL:…)"
              rows={2}
              className="px-2 py-1 rounded bg-[var(--bg)] border border-[var(--border)] text-xs font-mono"
            />
            {!checked && (
              <button type="button" disabled={!code.trim()} className={`${button} self-start`} onClick={() => check(code)}>
                Check code
              </button>
            )}
          </div>
        )}
        {checked && (
          <div className="flex flex-col gap-2 p-2 rounded border border-[var(--border)]">
            <div>
              Fingerprint <code className="font-semibold">{checked.fp}</code>: it must match the one on the new device.
            </div>
            <input
              type="text"
              value={name}
              maxLength={64}
              onChange={(e) => setName(e.target.value)}
              placeholder="Name it (e.g. Laptop)"
              className="px-2 py-1 rounded bg-[var(--bg)] border border-[var(--border)]"
            />
            <button
              type="button"
              disabled={busy || !name.trim()}
              className={`${button} self-start bg-[var(--accent)] text-white`}
              onClick={() =>
                run(async () => {
                  await linkDevice(code, name);
                  setCode("");
                  setName("");
                  setChecked(null);
                }, "Linked. The new device opens by itself.")
              }
            >
              Link device
            </button>
          </div>
        )}
        {message && <p className="text-xs text-[var(--muted)]">{message}</p>}
      </section>
    </div>
  );
}
