import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";

let testDb: ReturnType<typeof createTestDb>;
let base: ReturnType<typeof seedBaseData>;

vi.mock("~/db", () => ({
  get db() {
    return testDb;
  },
}));

import {
  getRevenueByCourse,
  getRevenueOverTime,
  getRevenueSummary,
  hasPublishedCourses,
  listCourseOwners,
  type RevenuePoint,
} from "./analyticsService";

/** A second instructor with a published course of their own. */
function seedRivalInstructor() {
  const instructor = testDb
    .insert(schema.users)
    .values({
      name: "Rival Instructor",
      email: "rival@example.com",
      role: schema.UserRole.Instructor,
    })
    .returning()
    .get();

  const course = testDb
    .insert(schema.courses)
    .values({
      title: "Rival Course",
      slug: "rival-course",
      description: "A rival course",
      salesCopy: "Sales copy.",
      instructorId: instructor.id,
      categoryId: base.category.id,
      status: schema.CourseStatus.Published,
    })
    .returning()
    .get();

  return { instructor, course };
}

function purchase(courseId: number, amountPaid: number, createdAt: string) {
  return testDb
    .insert(schema.purchases)
    .values({ userId: base.user.id, courseId, amountPaid, createdAt })
    .returning()
    .get();
}

/** An ISO timestamp exactly `days` days before now. */
function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

function pointAt(points: RevenuePoint[], bucket: string) {
  return points.find((point) => point.bucket === bucket);
}

describe("analyticsService", () => {
  beforeEach(() => {
    // The clock is frozen so that a row written "exactly 30 days ago" really is
    // exactly on the cutoff the service computes. Left running, the two
    // Date.now() calls differ by a millisecond or two and the boundary case
    // only passes when they happen to land in the same tick.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T12:00:00.000Z"));

    testDb = createTestDb();
    base = seedBaseData(testDb);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("getRevenueSummary", () => {
    it("counts only the instructor's own courses", () => {
      const rival = seedRivalInstructor();
      purchase(base.course.id, 5000, daysAgo(1));
      purchase(rival.course.id, 9900, daysAgo(1));

      const summary = getRevenueSummary(base.instructor.id, "all");

      expect(summary.grossCents).toBe(5000);
      expect(summary.purchaseCount).toBe(1);
    });

    it("spans every instructor when given a null instructor", () => {
      const rival = seedRivalInstructor();
      purchase(base.course.id, 5000, daysAgo(1));
      purchase(rival.course.id, 9900, daysAgo(1));

      const summary = getRevenueSummary(null, "all");

      expect(summary.grossCents).toBe(14900);
      expect(summary.purchaseCount).toBe(2);
    });

    it("takes 20% as the platform fee and leaves the rest as net", () => {
      purchase(base.course.id, 10000, daysAgo(1));

      const summary = getRevenueSummary(base.instructor.id, "all");

      expect(summary.grossCents).toBe(10000);
      expect(summary.feeCents).toBe(2000);
      expect(summary.netCents).toBe(8000);
    });

    it("rounds the fee so that fee and net still sum to gross", () => {
      // 3333 cents × 20% = 666.6 — the case where two independent roundings
      // would leave the three figures on screen disagreeing by a cent.
      purchase(base.course.id, 3333, daysAgo(1));

      const summary = getRevenueSummary(base.instructor.id, "all");

      expect(summary.feeCents).toBe(667);
      expect(summary.netCents).toBe(2666);
      expect(summary.feeCents + summary.netCents).toBe(summary.grossCents);
    });

    it("returns zeroes, not NaN, for an instructor with no purchases", () => {
      const summary = getRevenueSummary(base.instructor.id, "all");

      expect(summary).toEqual({
        grossCents: 0,
        feeCents: 0,
        netCents: 0,
        purchaseCount: 0,
      });
    });
  });

  describe("range tokens", () => {
    /** One purchase in each range band, so every token selects a known subset. */
    function seedAcrossTime() {
      purchase(base.course.id, 100, daysAgo(2));
      purchase(base.course.id, 1000, daysAgo(20));
      purchase(base.course.id, 10000, daysAgo(60));
      purchase(base.course.id, 100000, daysAgo(200));
    }

    it("7d covers the last week only", () => {
      seedAcrossTime();
      expect(getRevenueSummary(base.instructor.id, "7d").grossCents).toBe(100);
    });

    it("30d covers the last month", () => {
      seedAcrossTime();
      expect(getRevenueSummary(base.instructor.id, "30d").grossCents).toBe(
        1100
      );
    });

    it("90d covers the last quarter", () => {
      seedAcrossTime();
      expect(getRevenueSummary(base.instructor.id, "90d").grossCents).toBe(
        11100
      );
    });

    it("all covers everything, however old", () => {
      seedAcrossTime();
      expect(getRevenueSummary(base.instructor.id, "all").grossCents).toBe(
        111100
      );
    });

    it("includes a purchase sitting exactly on the cutoff", () => {
      // The known hazard: on the old seed the single largest transaction sat
      // precisely on the 30-day edge, where an exclusive comparison swung the
      // headline figure sixfold. The cutoff is inclusive.
      purchase(base.course.id, 60000, daysAgo(30));

      expect(getRevenueSummary(base.instructor.id, "30d").grossCents).toBe(
        60000
      );
    });

    it("excludes a purchase just the far side of the cutoff", () => {
      purchase(base.course.id, 60000, daysAgo(30.001));

      expect(getRevenueSummary(base.instructor.id, "30d").grossCents).toBe(0);
    });
  });

  describe("getRevenueOverTime", () => {
    it("buckets a short range by day, oldest first", () => {
      purchase(base.course.id, 1000, daysAgo(2));
      purchase(base.course.id, 500, daysAgo(2));
      purchase(base.course.id, 2000, daysAgo(1));

      const { granularity, points } = getRevenueOverTime(
        base.instructor.id,
        "7d"
      );

      expect(granularity).toBe("day");
      expect(points.map((point) => point.bucket)).toEqual([
        "2026-06-08",
        "2026-06-09",
        "2026-06-10",
        "2026-06-11",
        "2026-06-12",
        "2026-06-13",
        "2026-06-14",
        "2026-06-15",
      ]);
      expect(pointAt(points, "2026-06-13")).toEqual({
        bucket: "2026-06-13",
        grossCents: 1500,
        netCents: 1200,
      });
      expect(pointAt(points, "2026-06-14")).toEqual({
        bucket: "2026-06-14",
        grossCents: 2000,
        netCents: 1600,
      });
    });

    it("gives a 7-day range one point per day, including quiet ones", () => {
      purchase(base.course.id, 1000, daysAgo(1));

      const { points } = getRevenueOverTime(base.instructor.id, "7d");

      expect(points).toHaveLength(8);
      expect(points[0].bucket).toBe("2026-06-08");
      expect(points[0].grossCents).toBe(0);
      expect(points.at(-1)!.bucket).toBe("2026-06-15");
    });

    it("buckets all-time by month", () => {
      purchase(base.course.id, 1000, daysAgo(200));
      purchase(base.course.id, 3000, daysAgo(1));

      const { granularity, points } = getRevenueOverTime(
        base.instructor.id,
        "all"
      );

      expect(granularity).toBe("month");
      expect(points[0]).toEqual({
        bucket: "2025-11",
        grossCents: 1000,
        netCents: 800,
      });
      expect(points.at(-1)).toEqual({
        bucket: "2026-06",
        grossCents: 3000,
        netCents: 2400,
      });
    });

    it("counts only the instructor's own courses", () => {
      const rival = seedRivalInstructor();
      purchase(base.course.id, 1000, daysAgo(1));
      purchase(rival.course.id, 9900, daysAgo(1));

      const { points } = getRevenueOverTime(base.instructor.id, "7d");

      expect(pointAt(points, "2026-06-14")!.grossCents).toBe(1000);
    });

    it("returns no points at all for an instructor with no purchases", () => {
      expect(getRevenueOverTime(base.instructor.id, "all").points).toEqual([]);
    });

    it("still spans a fixed range with no purchases, at zero throughout", () => {
      const { points } = getRevenueOverTime(base.instructor.id, "7d");

      expect(points).toHaveLength(8);
      expect(points.every((point) => point.grossCents === 0)).toBe(true);
    });
  });

  describe("hasPublishedCourses", () => {
    it("is true for an instructor with a published course", () => {
      expect(hasPublishedCourses(base.instructor.id)).toBe(true);
    });

    it("is false when their only course is still a draft", () => {
      testDb
        .update(schema.courses)
        .set({ status: schema.CourseStatus.Draft })
        .run();

      expect(hasPublishedCourses(base.instructor.id)).toBe(false);
    });

    it("is false for an instructor with no courses at all", () => {
      const newcomer = testDb
        .insert(schema.users)
        .values({
          name: "New Instructor",
          email: "new@example.com",
          role: schema.UserRole.Instructor,
        })
        .returning()
        .get();

      expect(hasPublishedCourses(newcomer.id)).toBe(false);
    });
  });

  describe("getRevenueByCourse", () => {
    it("splits revenue per course, biggest earner first", () => {
      const second = testDb
        .insert(schema.courses)
        .values({
          title: "Second Course",
          slug: "second-course",
          description: "Another course",
          salesCopy: "Sales copy.",
          instructorId: base.instructor.id,
          categoryId: base.category.id,
          status: schema.CourseStatus.Published,
        })
        .returning()
        .get();

      purchase(base.course.id, 1000, daysAgo(1));
      purchase(second.id, 5000, daysAgo(1));
      purchase(second.id, 5000, daysAgo(1));

      const rows = getRevenueByCourse(base.instructor.id, "all");

      expect(rows).toEqual([
        {
          courseId: second.id,
          title: "Second Course",
          grossCents: 10000,
          feeCents: 2000,
          netCents: 8000,
          purchaseCount: 2,
        },
        {
          courseId: base.course.id,
          title: "Test Course",
          grossCents: 1000,
          feeCents: 200,
          netCents: 800,
          purchaseCount: 1,
        },
      ]);
    });

    it("honours the range", () => {
      purchase(base.course.id, 1000, daysAgo(1));
      purchase(base.course.id, 90000, daysAgo(200));

      expect(getRevenueByCourse(base.instructor.id, "7d")).toEqual([
        {
          courseId: base.course.id,
          title: "Test Course",
          grossCents: 1000,
          feeCents: 200,
          netCents: 800,
          purchaseCount: 1,
        },
      ]);
    });

    it("leaves out another instructor's courses", () => {
      const rival = seedRivalInstructor();
      purchase(rival.course.id, 9900, daysAgo(1));

      expect(getRevenueByCourse(base.instructor.id, "all")).toEqual([]);
    });
  });

  describe("listCourseOwners", () => {
    it("lists everyone who owns a course, by name", () => {
      seedRivalInstructor();

      expect(listCourseOwners()).toEqual([
        { id: expect.any(Number), name: "Rival Instructor" },
        { id: base.instructor.id, name: "Test Instructor" },
      ]);
    });

    it("includes an admin who owns a course", () => {
      // Their revenue lands in the platform-wide total either way, so leaving
      // them out of the picker would make the figures impossible to reconcile.
      const admin = testDb
        .insert(schema.users)
        .values({
          name: "Admin Owner",
          email: "admin@example.com",
          role: schema.UserRole.Admin,
        })
        .returning()
        .get();

      testDb
        .insert(schema.courses)
        .values({
          title: "Admin's Course",
          slug: "admins-course",
          description: "Owned by an admin",
          salesCopy: "Sales copy.",
          instructorId: admin.id,
          categoryId: base.category.id,
          status: schema.CourseStatus.Published,
        })
        .run();

      expect(listCourseOwners()).toContainEqual({
        id: admin.id,
        name: "Admin Owner",
      });
    });

    it("lists an owner once however many courses they own", () => {
      testDb
        .insert(schema.courses)
        .values({
          title: "Second Course",
          slug: "second-course",
          description: "Another course",
          salesCopy: "Sales copy.",
          instructorId: base.instructor.id,
          categoryId: base.category.id,
          status: schema.CourseStatus.Published,
        })
        .run();

      expect(listCourseOwners()).toHaveLength(1);
    });

    it("leaves out a user who owns nothing", () => {
      expect(listCourseOwners().map((owner) => owner.name)).not.toContain(
        "Test User"
      );
    });
  });
});
