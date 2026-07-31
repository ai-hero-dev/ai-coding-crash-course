import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  formatBucket,
  formatMoney,
  rangeStart,
  parseAnalyticsRange,
  splitRevenue,
} from "./analytics";

describe("analytics config", () => {
  describe("splitRevenue", () => {
    it("splits a round amount into fee and net", () => {
      expect(splitRevenue(10000)).toEqual({
        grossCents: 10000,
        feeCents: 2000,
        netCents: 8000,
      });
    });

    it("keeps fee and net adding up to gross when the split is fractional", () => {
      // Half a cent each way — the amounts where rounding both figures
      // independently leaves the page a cent short.
      for (const gross of [1, 3, 7, 3333, 99_999]) {
        const { feeCents, netCents } = splitRevenue(gross);
        expect(feeCents + netCents).toBe(gross);
      }
    });

    it("splits zero into zeroes", () => {
      expect(splitRevenue(0)).toEqual({
        grossCents: 0,
        feeCents: 0,
        netCents: 0,
      });
    });
  });

  describe("parseAnalyticsRange", () => {
    it("accepts each offered token", () => {
      expect(parseAnalyticsRange("7d")).toBe("7d");
      expect(parseAnalyticsRange("90d")).toBe("90d");
      expect(parseAnalyticsRange("all")).toBe("all");
    });

    it("falls back to the default for junk or a missing param", () => {
      expect(parseAnalyticsRange(null)).toBe("30d");
      expect(parseAnalyticsRange("last tuesday")).toBe("30d");
    });
  });

  describe("rangeStart", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-06-15T12:00:00.000Z"));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("has no start at all for all time", () => {
      expect(rangeStart("all")).toBeNull();
    });

    it("starts each window exactly that many days back", () => {
      // Every panel on the page compares against this one boundary, so the
      // service and the question queue can't disagree about what "30 days"
      // means. Inclusive: a row stamped exactly here is inside.
      expect(rangeStart("7d")).toBe("2026-06-08T12:00:00.000Z");
      expect(rangeStart("30d")).toBe("2026-05-16T12:00:00.000Z");
      expect(rangeStart("90d")).toBe("2026-03-17T12:00:00.000Z");
    });
  });

  describe("formatMoney", () => {
    it("always shows cents, and zero is a price rather than 'Free'", () => {
      expect(formatMoney(0)).toBe("$0.00");
      expect(formatMoney(4999)).toBe("$49.99");
    });

    it("groups thousands", () => {
      expect(formatMoney(123_456_789)).toBe("$1,234,567.89");
    });
  });

  describe("formatBucket", () => {
    it("labels a day bucket", () => {
      expect(formatBucket("2026-06-05")).toBe("5 Jun");
    });

    it("labels a month bucket", () => {
      expect(formatBucket("2025-11")).toBe("Nov 25");
    });
  });
});
