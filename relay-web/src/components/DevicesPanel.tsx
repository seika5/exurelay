"use client";

import { useEffect, useState } from "react";
import { useIdentity } from "@/context/IdentityContext";
import { fingerprint, readEnrollmentCode } from "@/lib/signed";
import { SectionTitle } from "@/components/InfoTip";
import { CodeInput } from "@/components/CodeInput";
import { ScrollList } from "@/components/ScrollList";
import { IconButton } from "@/components/icons";
import { confirmDialog } from "@/components/Modal";
import { btn, btnPrimary, field } from "@/components/ui";

/**
 * Settings → Devices (DESIGN.md §4 "Decided: linked devices"): my devices, linking a new one from its enrollment
 * code, and unlinking. Each device has its own keys; any of mine can link or unlink the others, with no admin.
 */
export function DevicesPanel() {
  const { identity, linkDevice, unlinkDevice, moveAdmin, isAdmin, directory } = useIdentity();
  const [code, setCode] = useState("");
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
    if (!r.ok) {
      setMessage(r.error);
      return false;
    }
    if (identity.myDevices.some((d) => d.keyHash === r.keyHash)) {
      setMessage("That device is already linked.");
      return false;
    }
    setCode(text);
    setChecked({ fp: await fingerprint(r.request.ecdh) });
    return true;
  };

  /** Run an action, then show `done`, or the message the action returns. */
  const run = async (fn: () => Promise<void | string>, done = "") => {
    setBusy(true);
    setMessage(null);
    try {
      setMessage((await fn()) || done);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4 text-sm">
      <section className="flex flex-col gap-2">
        <SectionTitle
          tip={`Each device has its own keys. Lost one? Unlink it from another device. Only the admin can replace your first device.${isAdmin ? " Admin works from one device at a time: move it before unlinking that device." : ""}`}
        >
          Your devices
        </SectionTitle>
        <ScrollList>
          {identity.myDevices.map((d) => {
            const isThis = d.keyHash === identity.deviceKeyHash;
            const isAdminDevice = adminSigs.includes(d.sig);
            const label = d.primary ? "First device" : d.name || "Device";
            return (
              <li key={d.keyHash} className="flex items-center gap-2 pl-3 pr-1 py-1.5">
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="break-words min-w-0">{label}</span>
                    {isThis && <span className="text-xs text-[var(--accent)] whitespace-nowrap">this device</span>}
                    {isAdminDevice && <span className="text-xs text-amber-300 whitespace-nowrap">admin device</span>}
                  </div>
                  <code className="text-xs text-[var(--muted)] whitespace-nowrap">{fps[d.keyHash] ?? ""}</code>
                </div>
                {isAdmin && !isAdminDevice && (
                  <IconButton
                    icon="makeAdmin"
                    label="Make admin device"
                    disabled={busy}
                    onClick={async () => {
                      if (await confirmDialog(`Make "${label}" your admin device?`, { ok: "Make admin" })) {
                        run(() => moveAdmin(d.keyHash), "Admin moved.");
                      }
                    }}
                  />
                )}
                {!d.primary && !isAdminDevice && (
                  <IconButton
                    icon="unlink"
                    label="Unlink"
                    danger
                    disabled={busy}
                    onClick={async () => {
                      const text = isThis
                        ? "Unlink this device? Its keys and messages here are deleted."
                        : `Unlink "${label}"? It won't be able to read or send as you.`;
                      if (await confirmDialog(text, { ok: "Unlink", danger: true })) run(() => unlinkDevice(d.keyHash), "Unlinked.");
                    }}
                  />
                )}
              </li>
            );
          })}
        </ScrollList>
      </section>

      <section className="flex flex-col gap-2">
        <SectionTitle tip="On the new device, join this server and create an identity. Then scan or paste the code it shows. Your messages are copied to it (text only, not files).">
          Link a device
        </SectionTitle>
        {!checked ? (
          <CodeInput value={code} onChange={setCode} onCheck={check} scanLabel="Scan code" disabled={busy} />
        ) : (
          <div className="flex flex-col gap-2 p-2 rounded border border-[var(--border)]">
            <p>
              Safety code: check it matches the new device.
              <br />
              <code className="font-semibold whitespace-nowrap">{checked.fp}</code>
            </p>
            <input
              type="text"
              value={name}
              maxLength={64}
              onChange={(e) => setName(e.target.value)}
              placeholder="Name it (e.g. Laptop)"
              className={field}
            />
            <div className="flex gap-2">
              <button
                type="button"
                disabled={busy}
                className={btn}
                onClick={() => {
                  setChecked(null);
                  setCode("");
                  setMessage(null);
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={busy || !name.trim()}
                className={btnPrimary}
                onClick={() =>
                  run(async () => {
                    await linkDevice(code, name);
                    setCode("");
                    setName("");
                    setChecked(null);
                  }, "Linked. Copying your messages to it.")
                }
              >
                Link device
              </button>
            </div>
          </div>
        )}
        {message && <p className="text-xs text-[var(--muted)]">{message}</p>}
      </section>
    </div>
  );
}
