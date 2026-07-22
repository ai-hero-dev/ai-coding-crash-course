import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Format a price in cents to a display string.
 * 0 or null/undefined → "Free", otherwise "$X.XX".
 */
export function formatPrice(cents: number | null | undefined): string {
  if (!cents) return "Free";
  return `$${(cents / 100).toFixed(2)}`;
}

/** Whole days between an ISO timestamp and now. Negative values clamp to 0. */
export function daysSince(iso: string): number {
  const elapsed = Date.now() - new Date(iso).getTime();
  return Math.max(0, Math.floor(elapsed / 86_400_000));
}

/**
 * A short "how long ago" label — "just now", "5m ago", "3h ago", "2d ago",
 * falling back to an absolute date beyond a month.
 *
 * Callers should render this with suppressHydrationWarning: the server and the
 * client can land either side of a minute boundary.
 */
export function formatRelativeTime(iso: string): string {
  const elapsed = Date.now() - new Date(iso).getTime();

  if (Number.isNaN(elapsed)) return "";
  if (elapsed < 60_000) return "just now";

  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;

  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function formatDuration(
  minutes: number,
  showHours: boolean,
  showSeconds: boolean,
  padZeros: boolean
): string {
  if (minutes <= 0) return padZeros ? "00m" : "0m";

  if (showHours && minutes >= 60) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    const hStr = padZeros ? String(h).padStart(2, "0") : String(h);
    const mStr = padZeros ? String(m).padStart(2, "0") : String(m);
    if (showSeconds) {
      return `${hStr}h ${mStr}m 00s`;
    }
    return m > 0 ? `${hStr}h ${mStr}m` : `${hStr}h`;
  }

  const mStr = padZeros ? String(minutes).padStart(2, "0") : String(minutes);
  if (showSeconds) {
    return `${mStr}m 00s`;
  }
  return `${mStr}m`;
}
