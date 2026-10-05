// ─── Analytics shared constants ───
// Shared by the analytics service (which does the arithmetic) and the
// analytics page (which labels and parses it).

/**
 * The platform's cut of every sale. A display calculation only: there is no
 * fee column and no payouts table.
 */
export const PLATFORM_FEE_RATE = 0.2;

export const ANALYTICS_RANGES = ["7d", "30d", "90d", "all"] as const;

export type AnalyticsRange = (typeof ANALYTICS_RANGES)[number];

export const DEFAULT_ANALYTICS_RANGE: AnalyticsRange = "30d";

export const ANALYTICS_RANGE_LABELS: Record<AnalyticsRange, string> = {
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
  all: "All time",
};

/** Reads a range token from a search param. Unknown values use the default. */
export function parseAnalyticsRange(value: string | null): AnalyticsRange {
  return (
    ANALYTICS_RANGES.find((range) => range === value) ?? DEFAULT_ANALYTICS_RANGE
  );
}

export const ANALYTICS_TABS = ["overview", "course"] as const;

export type AnalyticsTab = (typeof ANALYTICS_TABS)[number];

/** Reads a tab from a search param. Unknown values open the Overview tab. */
export function parseAnalyticsTab(value: string | null): AnalyticsTab {
  return ANALYTICS_TABS.find((tab) => tab === value) ?? "overview";
}

/** Reads a positive integer id from a search param, or null. */
export function parseIdParam(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value)) return null;
  const id = Number(value);
  return id > 0 ? id : null;
}

const moneyFormat = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

/** Integer cents as dollars. Unlike formatPrice, zero shows as "$0.00". */
export function formatCents(cents: number): string {
  return moneyFormat.format(cents / 100);
}
