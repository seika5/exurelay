"use client";

import { useEffect, useState } from "react";
import { useCall } from "@/context/CallContext";
import { Icon, type IconName } from "@/components/icons";

function ControlButton({
  icon,
  label,
  onClick,
  active,
  danger,
}: {
  icon: IconName;
  label: string;
  onClick: () => void;
  /** Shown filled (amber), e.g. while muted. */
  active?: boolean;
  danger?: boolean;
}) {
  const look = danger
    ? "bg-red-600 border-red-600 text-white hover:opacity-90"
    : active
      ? "bg-amber-500 border-amber-500 text-black"
      : "border-[var(--border)] text-[var(--text)] hover:bg-white/5";
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={danger ? undefined : !!active}
      onClick={onClick}
      className={`inline-flex flex-1 max-w-12 min-w-0 items-center justify-center h-9 touch:h-10 rounded border ${look}`}
    >
      <Icon name={icon} size={18} />
    </button>
  );
}

/**
 * The call's controls as one row of icon buttons: the same set and labels in the sidebar and in the call view.
 * Screen sharing is left out where the browser can't do it (iPhone).
 */
export function CallControls({ onHangUp, onChat }: { onHangUp: () => void; onChat?: () => void }) {
  const { muted, deafened, cameraOn, screenSharing, setMuted, setDeafened, setCameraOn, setScreenSharing } = useCall();
  const [canShare, setCanShare] = useState(false);
  useEffect(() => setCanShare(typeof navigator !== "undefined" && !!navigator.mediaDevices?.getDisplayMedia), []);

  return (
    <div className="flex items-center justify-center gap-1.5" role="group" aria-label="Call controls">
      {onChat && <ControlButton icon="callChat" label="Back to chat" onClick={onChat} />}
      <ControlButton icon={muted ? "callMicOff" : "callMic"} label={muted ? "Unmute" : "Mute"} active={muted} onClick={() => setMuted(!muted)} />
      <ControlButton
        icon={deafened ? "callHeadphonesOff" : "callHeadphones"}
        label={deafened ? "Undeafen" : "Deafen"}
        active={deafened}
        onClick={() => setDeafened(!deafened)}
      />
      <ControlButton
        icon={cameraOn ? "callCamera" : "callCameraOff"}
        label={cameraOn ? "Turn camera off" : "Turn camera on"}
        active={cameraOn}
        onClick={() => setCameraOn(!cameraOn)}
      />
      {(canShare || screenSharing) && (
        <ControlButton
          icon="callScreen"
          label={screenSharing ? "Stop sharing screen" : "Share screen"}
          active={screenSharing}
          onClick={() => setScreenSharing(!screenSharing)}
        />
      )}
      <ControlButton icon="callHangUp" label="Hang up" danger onClick={onHangUp} />
    </div>
  );
}
