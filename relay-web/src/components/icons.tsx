"use client";

/**
 * Simple 24×24 stroke icons drawn here (no icon library), and an icon-only button. An icon button always has an
 * accessible label and a hover tooltip, and a 40px tap area on touch screens; actions that can't be undone keep
 * their confirmation, so a curious tap is harmless.
 */

const PATHS = {
  // Settings tabs
  general: (
    <>
      <path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1" />
      <circle cx="15" cy="6" r="2" />
      <circle cx="9" cy="12" r="2" />
      <circle cx="17" cy="18" r="2" />
    </>
  ),
  devices: (
    <>
      <rect x="3" y="4" width="10" height="16" rx="2" />
      <rect x="15" y="9" width="6" height="11" rx="1.5" />
      <path d="M7 17h2" />
    </>
  ),
  storage: (
    <>
      <ellipse cx="12" cy="5.5" rx="7" ry="2.5" />
      <path d="M5 5.5v13c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-13M5 12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5" />
    </>
  ),
  plugins: <path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4" />,
  admin: <path d="M12 3l7 3v5c0 4.5-3 8.4-7 10-4-1.6-7-5.5-7-10V6zM9 12l2 2 4-4" />,
  // Actions
  makeAdmin: <path d="M12 3l7 3v5c0 4.5-3 8.4-7 10-4-1.6-7-5.5-7-10V6zM12 9v6M9 12h6" />,
  removeAdmin: <path d="M12 3l7 3v5c0 4.5-3 8.4-7 10-4-1.6-7-5.5-7-10V6zM9 12h6" />,
  removePerson: (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6M16 11h5" />
    </>
  ),
  trash: <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />,
  attach: <path d="M20 11.5l-8.5 8.5a5 5 0 0 1-7-7L13 4.5a3.5 3.5 0 0 1 5 5L9.5 18a2 2 0 0 1-3-3L14 7.5" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  refresh: <path d="M20 11a8 8 0 0 0-14.5-4.5M4 4v3.5h3.5M4 13a8 8 0 0 0 14.5 4.5M20 20v-3.5h-3.5" />,
  // Settings: scan a code (camera frame corners), show a QR
  settingsScan: <path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M7 12h10" />,
  settingsQr: (
    <>
      <rect x="4" y="4" width="6" height="6" rx="1" />
      <rect x="14" y="4" width="6" height="6" rx="1" />
      <rect x="4" y="14" width="6" height="6" rx="1" />
      <path d="M14 14h2v2M20 14v.01M14 20h.01M17 17v3h3" />
    </>
  ),
  // Chat
  // The members icon, a little smaller and lower, with a plus at the top right.
  chatNewGroup: (
    <>
      <circle cx="6.4" cy="9.1" r="2.9" />
      <path d="M1.05 18.9c0-2.95 2.38-5.33 5.33-5.33s5.33 2.38 5.33 5.33M12.1 6.2a2.9 2.9 0 0 1 0 5.75M13.75 13.75c1.72.66 2.87 2.38 2.87 4.35M20 4.5v6M17 7.5h6" />
    </>
  ),
  chatSettings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </>
  ),
  chatBack: <path d="M15 5l-7 7 7 7" />,
  chatMembers: (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20c0-3.6 2.9-6.5 6.5-6.5s6.5 2.9 6.5 6.5M16 4.5a3.5 3.5 0 0 1 0 7M18 13.7c2.1.8 3.5 2.9 3.5 5.3" />
    </>
  ),
  chatPencil: <path d="M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4" />,
  chatDownload: <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />,
  chatFile: <path d="M14 3H6v18h12V7zM14 3v4h4" />,
  chatReact: (
    <>
      <path d="M20.5 12A8.5 8.5 0 1 1 12 3.5" />
      <path d="M8.5 14.5c.9 1.2 2.1 1.8 3.5 1.8s2.6-.6 3.5-1.8M9 10h.01M15 10h.01M19 2.5v5M16.5 5h5" />
    </>
  ),
  chatCopy: <path d="M9 9h10v11H9zM5 15H4V4h11v1" />,
  chatReply: <path d="M10 5L4 11l6 6M4 11h10a6 6 0 0 1 6 6v2" />,
  chatShow: (
    <>
      <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  chatHide: <path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3 3.8M6.6 6.6C3.8 8.4 2 12 2 12s3.6 7 10 7c1.9 0 3.6-.6 5-1.5M9.9 9.9a3 3 0 0 0 4.2 4.2" />,
  chatContact: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <circle cx="9" cy="11" r="2" />
      <path d="M6 16c.5-1.4 1.6-2.2 3-2.2s2.5.8 3 2.2M15 10h3M15 14h3" />
    </>
  ),
  // Call controls
  callMic: (
    <>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </>
  ),
  callMicOff: (
    <>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3M4 4l16 16" />
    </>
  ),
  callHeadphones: (
    <>
      <path d="M4 17v-4a8 8 0 0 1 16 0v4" />
      <rect x="3" y="14" width="4" height="6" rx="1.5" />
      <rect x="17" y="14" width="4" height="6" rx="1.5" />
    </>
  ),
  callHeadphonesOff: (
    <>
      <path d="M4 17v-4a8 8 0 0 1 16 0v4M3 3l18 18" />
      <rect x="3" y="14" width="4" height="6" rx="1.5" />
      <rect x="17" y="14" width="4" height="6" rx="1.5" />
    </>
  ),
  callCamera: (
    <>
      <rect x="3" y="6" width="12" height="12" rx="2" />
      <path d="M15 10l6-3v10l-6-3" />
    </>
  ),
  callCameraOff: (
    <>
      <rect x="3" y="6" width="12" height="12" rx="2" />
      <path d="M15 10l6-3v10l-6-3M3 3l18 18" />
    </>
  ),
  callScreen: (
    <>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8M12 16v4M12 13V7M9 10l3-3 3 3" />
    </>
  ),
  callHangUp: <path d="M3 15.5v-2C3 11 7 9 12 9s9 2 9 4.5v2l-4.5 1-1-3c-2.3-.7-4.7-.7-7 0l-1 3z" />,
  callChat: <path d="M4 5h16v11H9l-5 4z" />,
  callBell: <path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15zM10 20.5a2 2 0 0 0 4 0" />,
  callSpeaker: <path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4zM15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" />,
  callStart: <path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z" />,
  chatSend: <path d="M4 12l16-8-6 16-2.5-6.5zM11.5 13.5L20 4" />,
  // Onboarding
  onbScan: <path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M4 12h16" />,
  onbBack: <path d="M15 5l-7 7 7 7" />,
  onbFolder: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
} as const;

/** Filled icons, each with its own grid. */
const FILLED = {
  // "Unlink" from SVG Repo (svgrepo.com/svg/352621), CC0.
  unlink: { viewBox: "0 0 512 512", d: "M304.083 405.907c4.686 4.686 4.686 12.284 0 16.971l-44.674 44.674c-59.263 59.262-155.693 59.266-214.961 0-59.264-59.265-59.264-155.696 0-214.96l44.675-44.675c4.686-4.686 12.284-4.686 16.971 0l39.598 39.598c4.686 4.686 4.686 12.284 0 16.971l-44.675 44.674c-28.072 28.073-28.072 73.75 0 101.823 28.072 28.072 73.75 28.073 101.824 0l44.674-44.674c4.686-4.686 12.284-4.686 16.971 0l39.597 39.598zm-56.568-260.216c4.686 4.686 12.284 4.686 16.971 0l44.674-44.674c28.072-28.075 73.75-28.073 101.824 0 28.072 28.073 28.072 73.75 0 101.823l-44.675 44.674c-4.686 4.686-4.686 12.284 0 16.971l39.598 39.598c4.686 4.686 12.284 4.686 16.971 0l44.675-44.675c59.265-59.265 59.265-155.695 0-214.96-59.266-59.264-155.695-59.264-214.961 0l-44.674 44.674c-4.686 4.686-4.686 12.284 0 16.971l39.597 39.598zm234.828 359.28l22.627-22.627c9.373-9.373 9.373-24.569 0-33.941L63.598 7.029c-9.373-9.373-24.569-9.373-33.941 0L7.029 29.657c-9.373 9.373-9.373 24.569 0 33.941l441.373 441.373c9.373 9.372 24.569 9.372 33.941 0z" },
} as const;

export type IconName = keyof typeof PATHS | keyof typeof FILLED;

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  if (name in FILLED) {
    const f = FILLED[name as keyof typeof FILLED];
    return (
      <svg viewBox={f.viewBox} width={size} height={size} fill="currentColor" aria-hidden="true" className="shrink-0">
        <path d={f.d} />
      </svg>
    );
  }
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="shrink-0"
    >
      {PATHS[name as keyof typeof PATHS]}
    </svg>
  );
}

/** An icon-only button. `danger` colors it red, for actions that remove something. */
export function IconButton({
  icon,
  label,
  onClick,
  disabled,
  danger,
}: {
  icon: IconName;
  label: string;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex shrink-0 items-center justify-center w-8 h-8 touch:w-10 touch:h-10 rounded border border-[var(--border)] disabled:opacity-50 ${danger ? "text-red-400" : "text-[var(--text)]"}`}
    >
      <Icon name={icon} />
    </button>
  );
}
