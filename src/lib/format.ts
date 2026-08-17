/**
 * Timestamps are stored in UTC and displayed in Asia/Kolkata, per the spec.
 * The zone is pinned explicitly rather than left to the browser so the log
 * reads the same on a laptop, a phone, and a server-rendered page.
 */
export const LAB_TIME_ZONE = "Asia/Kolkata";

const dateTime = new Intl.DateTimeFormat("en-IN", {
  timeZone: LAB_TIME_ZONE,
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hour12: true,
});

const dateOnly = new Intl.DateTimeFormat("en-IN", {
  timeZone: LAB_TIME_ZONE,
  day: "2-digit",
  month: "short",
  year: "numeric",
});

export function formatDateTime(value: Date): string {
  return dateTime.format(value);
}

export function formatDate(value: Date): string {
  return dateOnly.format(value);
}

/** "just now", "12 min ago", "3 h ago", then an absolute date. */
export function formatRelative(value: Date, now: Date = new Date()): string {
  const seconds = Math.round((now.getTime() - value.getTime()) / 1000);

  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h ago`;
  if (seconds < 604_800) return `${Math.floor(seconds / 86_400)} d ago`;
  return formatDate(value);
}

/** Signed quantity with an explicit plus, so direction is unmissable. */
export function formatDelta(delta: number): string {
  return delta > 0 ? `+${delta}` : String(delta);
}

const REASON_LABELS: Record<string, string> = {
  receipt: "Received",
  issue: "Taken out",
  return: "Returned",
  adjustment: "Adjusted",
  reversal: "Undone",
};

export function formatReason(reason: string): string {
  return REASON_LABELS[reason] ?? reason;
}

export const INR = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 2,
});
