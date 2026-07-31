import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
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
  getAudienceSummary,
  getRatingSummary,
  getRevenueByCourse,
  getRevenueOverTime,
  getRevenueSummary,
  getStudentRevenue,
  getTopBuyers,
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

function seedStudent(name: string) {
  return testDb
    .insert(schema.users)
    .values({
      name,
      email: `${name.toLowerCase().replace(/\W+/g, ".")}@example.com`,
      role: schema.UserRole.Student,
    })
    .returning()
    .get();
}

function enrol(userId: number, courseId: number, enrolledAt = daysAgo(1)) {
  return testDb
    .insert(schema.enrollments)
    .values({ userId, courseId, enrolledAt })
    .returning()
    .get();
}

function buy(
  userId: number,
  courseId: number,
  amountPaid: number,
  createdAt = daysAgo(1)
) {
  return testDb
    .insert(schema.purchases)
    .values({ userId, courseId, amountPaid, createdAt })
    .returning()
    .get();
}

/**
 * One purchase row covering several seats, with a coupon minted per seat —
 * the shape that makes buyers and students diverge.
 */
function teamPurchase(options: {
  buyerId: number;
  courseId: number;
  amountPaid: number;
  seats: number;
  createdAt?: string;
}) {
  const { buyerId, courseId, amountPaid, seats } = options;
  const createdAt = options.createdAt ?? daysAgo(1);

  const team = testDb
    .insert(schema.teams)
    .values({ createdAt })
    .returning()
    .get();

  const purchaseRow = buy(buyerId, courseId, amountPaid, createdAt);

  const couponRows = testDb
    .insert(schema.coupons)
    .values(
      Array.from({ length: seats }, (_, seat) => ({
        teamId: team.id,
        courseId,
        code: `SEAT-${purchaseRow.id}-${seat}`,
        purchaseId: purchaseRow.id,
        createdAt,
      }))
    )
    .returning()
    .all();

  return { team, purchase: purchaseRow, coupons: couponRows };
}

/** Claims a seat: the coupon is consumed and the redeemer is enrolled. */
function redeem(
  coupon: typeof schema.coupons.$inferSelect,
  userId: number,
  at = daysAgo(1)
) {
  testDb
    .update(schema.coupons)
    .set({ redeemedByUserId: userId, redeemedAt: at })
    .where(eq(schema.coupons.id, coupon.id))
    .run();

  enrol(userId, coupon.courseId, at);
}

function seedSecondCourse() {
  return testDb
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
}

/**
 * A five-seat team purchase of which two seats are claimed: one buyer, two
 * students, and three seats nobody is using.
 */
function seedTeamScenario() {
  const boss = seedStudent("Bossy Buyer");
  const { coupons } = teamPurchase({
    buyerId: boss.id,
    courseId: base.course.id,
    amountPaid: 50000,
    seats: 5,
  });

  const olivia = seedStudent("Olivia");
  const liam = seedStudent("Liam");
  redeem(coupons[0], olivia.id);
  redeem(coupons[1], liam.id);

  return { boss, olivia, liam, coupons };
}

function rate(
  userId: number,
  courseId: number,
  rating: number,
  at = daysAgo(1)
) {
  testDb
    .insert(schema.courseRatings)
    .values({ userId, courseId, rating, createdAt: at, updatedAt: at })
    .run();
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

  describe("getAudienceSummary", () => {
    it("counts buyers and students as different numbers when a team buys seats", () => {
      // One buyer who never takes the course, two students who never paid.
      seedTeamScenario();
      enrol(base.user.id, base.course.id);
      buy(base.user.id, base.course.id, 10000);

      const summary = getAudienceSummary(base.instructor.id, "all");

      // Bossy and Test User paid; Olivia, Liam and Test User are enrolled.
      expect(summary.buyerCount).toBe(2);
      expect(summary.studentCount).toBe(3);
    });

    it("averages revenue per student across redeemed seats", () => {
      seedTeamScenario();
      enrol(base.user.id, base.course.id);
      buy(base.user.id, base.course.id, 10000);

      // Each of the five seats is worth 10000; two are claimed, and Test User
      // paid 10000 of their own. Three students, 10000 each.
      expect(getAudienceSummary(base.instructor.id, "all")).toEqual({
        buyerCount: 2,
        studentCount: 3,
        revenuePerStudentCents: 10000,
      });
    });

    it("reports zeroes rather than NaN with nothing to count", () => {
      expect(getAudienceSummary(base.instructor.id, "all")).toEqual({
        buyerCount: 0,
        studentCount: 0,
        revenuePerStudentCents: null,
      });
    });

    it("honours the range", () => {
      buy(base.user.id, base.course.id, 10000, daysAgo(200));
      enrol(base.user.id, base.course.id, daysAgo(200));

      const recent = seedStudent("Recent Student");
      buy(recent.id, base.course.id, 10000, daysAgo(2));
      enrol(recent.id, base.course.id, daysAgo(2));

      const summary = getAudienceSummary(base.instructor.id, "7d");

      expect(summary.buyerCount).toBe(1);
      expect(summary.studentCount).toBe(1);
    });

    it("leaves out another instructor's audience", () => {
      const rival = seedRivalInstructor();
      buy(base.user.id, rival.course.id, 10000);
      enrol(base.user.id, rival.course.id);

      expect(getAudienceSummary(base.instructor.id, "all")).toEqual({
        buyerCount: 0,
        studentCount: 0,
        revenuePerStudentCents: null,
      });
    });

    it("spans every instructor when the filter is null", () => {
      const rival = seedRivalInstructor();
      buy(base.user.id, rival.course.id, 10000);
      enrol(base.user.id, rival.course.id);

      const summary = getAudienceSummary(null, "all");

      expect(summary.buyerCount).toBe(1);
      expect(summary.studentCount).toBe(1);
    });
  });

  describe("getStudentRevenue", () => {
    it("walks a redeemed seat back to the purchase that minted it", () => {
      const { olivia, liam } = seedTeamScenario();

      const revenue = getStudentRevenue(base.instructor.id, "all");

      // 50000 over five seats: each claimed seat carries 10000, and the
      // student paid nothing themselves.
      expect(revenue).toEqual([
        { userId: liam.id, name: "Liam", revenueCents: 10000 },
        { userId: olivia.id, name: "Olivia", revenueCents: 10000 },
      ]);
    });

    it("leaves unclaimed seats attributed to nobody", () => {
      seedTeamScenario();

      const total = getStudentRevenue(base.instructor.id, "all").reduce(
        (sum, student) => sum + student.revenueCents,
        0
      );

      // Two of five seats claimed — the other 30000 belongs to no student.
      expect(total).toBe(20000);
    });

    it("adds a student's own purchase to the seat they redeemed", () => {
      const { olivia } = seedTeamScenario();
      const second = seedSecondCourse();
      buy(olivia.id, second.id, 4900);
      enrol(olivia.id, second.id);

      const olivias = getStudentRevenue(base.instructor.id, "all").find(
        (student) => student.userId === olivia.id
      );

      expect(olivias?.revenueCents).toBe(14900);
    });

    it("credits a team buyer who takes a seat with that seat and no more", () => {
      // The team admin who also takes the course would otherwise be credited
      // with the whole purchase while their colleagues are credited with their
      // seats — the same money counted twice over.
      const { boss, coupons } = seedTeamScenario();
      redeem(coupons[2], boss.id);

      const revenue = getStudentRevenue(base.instructor.id, "all");
      const total = revenue.reduce(
        (sum, student) => sum + student.revenueCents,
        0
      );

      expect(
        revenue.find((student) => student.userId === boss.id)?.revenueCents
      ).toBe(10000);
      expect(total).toBe(30000);
    });

    it("ignores a seat bought for another instructor's course", () => {
      const rival = seedRivalInstructor();
      const boss = seedStudent("Rival Boss");
      const { coupons } = teamPurchase({
        buyerId: boss.id,
        courseId: rival.course.id,
        amountPaid: 50000,
        seats: 5,
      });
      const student = seedStudent("Rival Student");
      redeem(coupons[0], student.id);

      expect(getStudentRevenue(base.instructor.id, "all")).toEqual([]);
    });

    it("lists a student who enrolled without paying anything at all", () => {
      const freeloader = seedStudent("Freeloader");
      enrol(freeloader.id, base.course.id);

      expect(getStudentRevenue(base.instructor.id, "all")).toEqual([
        { userId: freeloader.id, name: "Freeloader", revenueCents: 0 },
      ]);
    });
  });

  describe("getTopBuyers", () => {
    it("ranks by total spend and stops at ten", () => {
      for (let index = 1; index <= 12; index++) {
        const buyer = seedStudent(`Buyer ${index}`);
        buy(buyer.id, base.course.id, index * 1000);
      }

      const buyers = getTopBuyers(base.instructor.id, "all");

      expect(buyers).toHaveLength(10);
      expect(buyers[0].spendCents).toBe(12000);
      expect(buyers.at(-1)?.spendCents).toBe(3000);
      expect(buyers.map((buyer) => buyer.name)).not.toContain("Buyer 1");
    });

    it("sums a buyer's purchases without multiplying them by their seats", () => {
      const boss = seedStudent("Bossy Buyer");
      teamPurchase({
        buyerId: boss.id,
        courseId: base.course.id,
        amountPaid: 50000,
        seats: 5,
      });
      buy(boss.id, base.course.id, 4900);

      const buyer = getTopBuyers(base.instructor.id, "all")[0];

      expect(buyer.spendCents).toBe(54900);
      expect(buyer.purchaseCount).toBe(2);
    });

    it("flags a team buyer with the seats they bought and the ones nobody claimed", () => {
      const { boss } = seedTeamScenario();

      const buyers = getTopBuyers(base.instructor.id, "all");

      expect(buyers).toEqual([
        {
          userId: boss.id,
          name: "Bossy Buyer",
          email: "bossy.buyer@example.com",
          spendCents: 50000,
          purchaseCount: 1,
          seatsBought: 5,
          seatsUnredeemed: 3,
          enrolled: false,
        },
      ]);
    });

    it("keeps a buyer who never enrolled", () => {
      const absentee = seedStudent("Absentee");
      buy(absentee.id, base.course.id, 4900);

      const buyer = getTopBuyers(base.instructor.id, "all")[0];

      expect(buyer.name).toBe("Absentee");
      expect(buyer.enrolled).toBe(false);
      expect(buyer.seatsBought).toBe(0);
    });

    it("marks a buyer who did enrol", () => {
      const student = seedStudent("Keen Student");
      buy(student.id, base.course.id, 4900);
      enrol(student.id, base.course.id);

      expect(getTopBuyers(base.instructor.id, "all")[0].enrolled).toBe(true);
    });

    it("honours the range and the instructor filter", () => {
      const rival = seedRivalInstructor();
      const old = seedStudent("Old Buyer");
      const elsewhere = seedStudent("Elsewhere Buyer");
      const recent = seedStudent("Recent Buyer");

      buy(old.id, base.course.id, 90000, daysAgo(200));
      buy(elsewhere.id, rival.course.id, 90000, daysAgo(1));
      buy(recent.id, base.course.id, 1000, daysAgo(1));

      expect(
        getTopBuyers(base.instructor.id, "7d").map((buyer) => buyer.name)
      ).toEqual(["Recent Buyer"]);
    });

    it("is empty when nobody has bought anything", () => {
      expect(getTopBuyers(base.instructor.id, "all")).toEqual([]);
    });
  });

  describe("getRatingSummary", () => {
    it("averages ratings across the instructor's courses", () => {
      const second = seedSecondCourse();
      rate(base.user.id, base.course.id, 5);
      rate(seedStudent("Second Rater").id, base.course.id, 4);
      rate(base.user.id, second.id, 3);

      expect(getRatingSummary(base.instructor.id, "all")).toEqual({
        average: 4,
        count: 3,
      });
    });

    it("rounds the average to one decimal place", () => {
      rate(base.user.id, base.course.id, 5);
      rate(seedStudent("Second Rater").id, base.course.id, 4);
      rate(seedStudent("Third Rater").id, base.course.id, 4);

      expect(getRatingSummary(base.instructor.id, "all").average).toBe(4.3);
    });

    it("leaves out another instructor's ratings", () => {
      const rival = seedRivalInstructor();
      rate(base.user.id, rival.course.id, 1);
      rate(seedStudent("Fan").id, base.course.id, 5);

      expect(getRatingSummary(base.instructor.id, "all")).toEqual({
        average: 5,
        count: 1,
      });
    });

    it("honours the range", () => {
      rate(base.user.id, base.course.id, 1, daysAgo(200));
      rate(seedStudent("Recent Rater").id, base.course.id, 5, daysAgo(2));

      expect(getRatingSummary(base.instructor.id, "7d")).toEqual({
        average: 5,
        count: 1,
      });
    });

    it("has no average at all when nobody has rated", () => {
      expect(getRatingSummary(base.instructor.id, "all")).toEqual({
        average: null,
        count: 0,
      });
    });
  });
});
