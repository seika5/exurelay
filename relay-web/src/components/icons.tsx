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
  unlink: <path d="M9 15l-2 2a3 3 0 0 1-4-4l3-3a3 3 0 0 1 4 0M15 9l2-2a3 3 0 0 1 4 4l-3 3a3 3 0 0 1-4 0M4 4l3 3M20 20l-3-3" />,
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
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
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
      {PATHS[name]}
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
  onClick: () => void;
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
