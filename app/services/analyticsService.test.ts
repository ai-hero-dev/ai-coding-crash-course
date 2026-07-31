import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";

let testDb: ReturnType<typeof createTestDb>;
let base: ReturnType<typeof seedBaseData>;
/** Keeps generated buyers' emails apart within a test's database. */
let buyerCount = 0;

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
  getCourseDropOff,
  getCourseProgressSummary,
  getCourseQuizPassRates,
  getCourseRevenueByCountry,
  getTopBuyers,
  hasPublishedCourses,
  listCourseOwners,
  listInstructorCourses,
  type CourseFunnel,
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

/**
 * Modules and lessons for a course, given a lesson count per module.
 *
 * Returns the modules in course order, each with its lessons in position
 * order, so a test can name a lesson by where it sits in the course.
 */
function seedCurriculum(courseId: number, lessonsPerModule: number[]) {
  return lessonsPerModule.map((lessonCount, moduleIndex) => {
    const moduleRow = testDb
      .insert(schema.modules)
      .values({
        courseId,
        title: `Module ${moduleIndex + 1}`,
        position: moduleIndex,
      })
      .returning()
      .get();

    const lessonRows = testDb
      .insert(schema.lessons)
      .values(
        Array.from({ length: lessonCount }, (_, lessonIndex) => ({
          moduleId: moduleRow.id,
          title: `Module ${moduleIndex + 1} lesson ${lessonIndex + 1}`,
          position: lessonIndex,
        }))
      )
      .returning()
      .all();

    return { module: moduleRow, lessons: lessonRows };
  });
}

/** Every lesson of a seeded curriculum, in course order. */
function lessonIdsOf(curriculum: ReturnType<typeof seedCurriculum>): number[] {
  return curriculum.flatMap((entry) =>
    entry.lessons.map((lesson) => lesson.id)
  );
}

function completeLesson(userId: number, lessonId: number, at = daysAgo(1)) {
  testDb
    .insert(schema.lessonProgress)
    .values({
      userId,
      lessonId,
      status: schema.LessonProgressStatus.Completed,
      completedAt: at,
    })
    .run();
}

function startLesson(userId: number, lessonId: number) {
  testDb
    .insert(schema.lessonProgress)
    .values({
      userId,
      lessonId,
      status: schema.LessonProgressStatus.InProgress,
    })
    .run();
}

/** A student who enrolled and completed the first `count` lessons in order. */
function studentWhoStoppedAfter(
  name: string,
  courseId: number,
  lessonIds: number[],
  count: number
) {
  const student = seedStudent(name);
  enrol(student.id, courseId);
  for (const lessonId of lessonIds.slice(0, count)) {
    completeLesson(student.id, lessonId);
  }
  return student;
}

/** The funnel's lessons, flattened back into course order. */
function funnelLessons(funnel: CourseFunnel) {
  return funnel.modules.flatMap((module) => module.lessons);
}

/** A quiz hung off a lesson, passing at 70% unless a test says otherwise. */
function seedQuiz(lessonId: number, title: string, passingScore = 0.7) {
  return testDb
    .insert(schema.quizzes)
    .values({ lessonId, title, passingScore })
    .returning()
    .get();
}

/**
 * An attempt at a quiz, as the quiz runner would record it: scores are the
 * fractions it stores rather than percentages, and the verdict is settled
 * against that quiz's own passing score rather than a threshold repeated here.
 */
function attempt(
  userId: number,
  quizId: number,
  score: number,
  attemptedAt = daysAgo(1)
) {
  const quiz = testDb
    .select()
    .from(schema.quizzes)
    .where(eq(schema.quizzes.id, quizId))
    .get()!;

  return testDb
    .insert(schema.quizAttempts)
    .values({
      userId,
      quizId,
      score,
      passed: score >= quiz.passingScore,
      attemptedAt,
    })
    .returning()
    .get();
}

/** A sale of a course to someone new, from a country or from nowhere. */
function buyFrom(
  courseId: number,
  amountPaid: number,
  country: string | null,
  createdAt = daysAgo(1)
) {
  const buyer = seedStudent(`Buyer ${(buyerCount += 1)}`);
  return testDb
    .insert(schema.purchases)
    .values({ userId: buyer.id, courseId, amountPaid, country, createdAt })
    .returning()
    .get();
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
    buyerCount = 0;
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

  describe("getCourseProgressSummary", () => {
    it("averages progress over enrolled students, counting lessons", () => {
      const lessonIds = lessonIdsOf(seedCurriculum(base.course.id, [4]));

      // 100%, 25% and 0% — an average of 41.66…, which is 42 rounded.
      studentWhoStoppedAfter("Finisher", base.course.id, lessonIds, 4);
      studentWhoStoppedAfter("Dabbler", base.course.id, lessonIds, 1);
      studentWhoStoppedAfter("Absentee", base.course.id, lessonIds, 0);

      const summary = getCourseProgressSummary(base.course.id);

      expect(summary.enrolledCount).toBe(3);
      expect(summary.totalLessons).toBe(4);
      expect(summary.averageProgressPercent).toBe(42);
    });

    it("counts finished students separately from average progress", () => {
      const lessonIds = lessonIdsOf(seedCurriculum(base.course.id, [2, 2]));

      // Healthy average, but only one of the four is actually done: the two
      // figures disagree, which is exactly why both are shown.
      studentWhoStoppedAfter("Finisher", base.course.id, lessonIds, 4);
      studentWhoStoppedAfter("Nearly", base.course.id, lessonIds, 3);
      studentWhoStoppedAfter("Halfway", base.course.id, lessonIds, 2);
      studentWhoStoppedAfter("Started", base.course.id, lessonIds, 1);

      const summary = getCourseProgressSummary(base.course.id);

      expect(summary.averageProgressPercent).toBe(63);
      expect(summary.finishedCount).toBe(1);
    });

    it("does not count an in-progress lesson as completed", () => {
      const lessonIds = lessonIdsOf(seedCurriculum(base.course.id, [2]));
      const student = studentWhoStoppedAfter(
        "Watcher",
        base.course.id,
        lessonIds,
        1
      );
      startLesson(student.id, lessonIds[1]);

      expect(getCourseProgressSummary(base.course.id)).toMatchObject({
        averageProgressPercent: 50,
        finishedCount: 0,
      });
    });

    it("ignores progress made by someone who is not enrolled", () => {
      const lessonIds = lessonIdsOf(seedCurriculum(base.course.id, [2]));
      studentWhoStoppedAfter("Enrolled", base.course.id, lessonIds, 1);

      const gatecrasher = seedStudent("Gatecrasher");
      completeLesson(gatecrasher.id, lessonIds[0]);
      completeLesson(gatecrasher.id, lessonIds[1]);

      expect(getCourseProgressSummary(base.course.id)).toMatchObject({
        enrolledCount: 1,
        averageProgressPercent: 50,
      });
    });

    it("has no average at all for a course nobody has enrolled in", () => {
      seedCurriculum(base.course.id, [3]);

      expect(getCourseProgressSummary(base.course.id)).toEqual({
        enrolledCount: 0,
        totalLessons: 3,
        averageProgressPercent: null,
        finishedCount: 0,
      });
    });

    it("returns null rather than dividing by an empty curriculum", () => {
      enrol(base.user.id, base.course.id);

      expect(getCourseProgressSummary(base.course.id)).toEqual({
        enrolledCount: 1,
        totalLessons: 0,
        averageProgressPercent: null,
        finishedCount: 0,
      });
    });
  });

  describe("getCourseDropOff", () => {
    it("counts, at each lesson, the students who got at least that far", () => {
      const lessonIds = lessonIdsOf(seedCurriculum(base.course.id, [4]));

      studentWhoStoppedAfter("Finisher", base.course.id, lessonIds, 4);
      studentWhoStoppedAfter("Quitter", base.course.id, lessonIds, 2);
      studentWhoStoppedAfter("Tourist", base.course.id, lessonIds, 1);

      const funnel = getCourseDropOff(base.course.id);

      expect(funnel.enrolledCount).toBe(3);
      expect(
        funnelLessons(funnel).map((lesson) => lesson.reachedCount)
      ).toEqual([3, 2, 1, 1]);
    });

    it("never rises, even when students skip lessons at random", () => {
      const lessonIds = lessonIdsOf(seedCurriculum(base.course.id, [3, 3]));

      // A messy cohort: skipped lessons, an unfinished last lesson, a student
      // who never opened anything.
      const skipper = seedStudent("Skipper");
      enrol(skipper.id, base.course.id);
      completeLesson(skipper.id, lessonIds[0]);
      completeLesson(skipper.id, lessonIds[4]);
      startLesson(skipper.id, lessonIds[5]);
      studentWhoStoppedAfter("Steady", base.course.id, lessonIds, 4);
      studentWhoStoppedAfter("Browser", base.course.id, lessonIds, 1);
      studentWhoStoppedAfter("Absentee", base.course.id, lessonIds, 0);

      const counts = funnelLessons(getCourseDropOff(base.course.id)).map(
        (lesson) => lesson.reachedCount
      );

      for (let i = 1; i < counts.length; i++) {
        expect(counts[i]).toBeLessThanOrEqual(counts[i - 1]);
      }
    });

    it("does not read a skipped lesson as a drop", () => {
      const lessonIds = lessonIdsOf(seedCurriculum(base.course.id, [4]));

      // Skipped the second lesson and carried on to the end: still present at
      // every bar, because the alternative would send an instructor chasing a
      // problem that isn't there.
      const student = seedStudent("Skipper");
      enrol(student.id, base.course.id);
      completeLesson(student.id, lessonIds[0]);
      completeLesson(student.id, lessonIds[2]);
      completeLesson(student.id, lessonIds[3]);

      const lessonBars = funnelLessons(getCourseDropOff(base.course.id));

      expect(lessonBars.map((lesson) => lesson.reachedCount)).toEqual([
        1, 1, 1, 1,
      ]);
      expect(lessonBars.map((lesson) => lesson.dropFromPrevious)).toEqual([
        0, 0, 0, 0,
      ]);
    });

    it("counts a lesson in progress as reached", () => {
      const lessonIds = lessonIdsOf(seedCurriculum(base.course.id, [3]));
      const student = studentWhoStoppedAfter(
        "Watcher",
        base.course.id,
        lessonIds,
        1
      );
      startLesson(student.id, lessonIds[1]);

      expect(
        funnelLessons(getCourseDropOff(base.course.id)).map(
          (lesson) => lesson.reachedCount
        )
      ).toEqual([1, 1, 0]);
    });

    it("reports the drop into each lesson, starting from the enrolled count", () => {
      const lessonIds = lessonIdsOf(seedCurriculum(base.course.id, [3]));

      studentWhoStoppedAfter("Finisher", base.course.id, lessonIds, 3);
      studentWhoStoppedAfter("Quitter", base.course.id, lessonIds, 1);
      // Enrolled and never opened it: a drop before the first lesson.
      studentWhoStoppedAfter("Absentee", base.course.id, lessonIds, 0);

      expect(
        funnelLessons(getCourseDropOff(base.course.id)).map(
          (lesson) => lesson.dropFromPrevious
        )
      ).toEqual([1, 1, 0]);
    });

    it("groups lessons under their modules, with a subtotal each", () => {
      const curriculum = seedCurriculum(base.course.id, [2, 2]);
      const lessonIds = lessonIdsOf(curriculum);

      studentWhoStoppedAfter("Finisher", base.course.id, lessonIds, 4);
      studentWhoStoppedAfter("Half", base.course.id, lessonIds, 2);
      studentWhoStoppedAfter("Starter", base.course.id, lessonIds, 1);

      const funnel = getCourseDropOff(base.course.id);

      expect(funnel.modules.map((module) => module.title)).toEqual([
        "Module 1",
        "Module 2",
      ]);
      expect(funnel.modules[0].moduleId).toBe(curriculum[0].module.id);
      // Students who reached the module at all, and how many it lost.
      expect(funnel.modules[0]).toMatchObject({
        reachedCount: 3,
        dropWithin: 1,
      });
      expect(funnel.modules[1]).toMatchObject({
        reachedCount: 1,
        dropWithin: 0,
      });
      expect(
        funnel.modules[1].lessons.map((lesson) => lesson.lessonId)
      ).toEqual([lessonIds[2], lessonIds[3]]);
    });

    it("finds both cliffs a cohort was deliberately made to quit at", () => {
      // The shape the seed plants (scripts/seed.ts): two cliffs per course,
      // some students who buy and never open it, some who finish, and a
      // scattering of ordinary stopping points in between. As in the seed, a
      // stopping student leaves the lesson after their last completed one
      // half-watched — which counts as reached, so each cliff shows up as the
      // drop into the lesson *after* the one they abandoned.
      const lessonIds = lessonIdsOf(seedCurriculum(base.course.id, [4, 4, 4]));
      const [firstCliff, secondCliff] = [3, 7];

      function stopsAt(name: string, lastCompleted: number) {
        const student = studentWhoStoppedAfter(
          name,
          base.course.id,
          lessonIds,
          lastCompleted + 1
        );
        startLesson(student.id, lessonIds[lastCompleted + 1]);
      }

      for (let i = 0; i < 8; i++) stopsAt(`First cliff ${i}`, firstCliff);
      for (let i = 0; i < 5; i++) stopsAt(`Second cliff ${i}`, secondCliff);
      for (let i = 0; i < 2; i++) {
        studentWhoStoppedAfter(
          `Never opened ${i}`,
          base.course.id,
          lessonIds,
          0
        );
      }
      for (let i = 0; i < 3; i++) {
        studentWhoStoppedAfter(`Finisher ${i}`, base.course.id, lessonIds, 12);
      }
      stopsAt("Wanderer", 1);

      const lessonBars = funnelLessons(getCourseDropOff(base.course.id));
      const steepest = [...lessonBars]
        .sort((a, b) => b.dropFromPrevious - a.dropFromPrevious)
        .slice(0, 2);

      // The second cliff is found as well as the first, even though the first
      // has already thinned the cohort that reaches it.
      expect(steepest.map((lesson) => lesson.lessonId)).toEqual([
        lessonIds[firstCliff + 2],
        lessonIds[secondCliff + 2],
      ]);
      expect(steepest.map((lesson) => lesson.dropFromPrevious)).toEqual([8, 5]);
      // And the two who bought it and never opened it are lost at the first bar.
      expect(lessonBars[0].dropFromPrevious).toBe(2);
    });

    it("ignores students enrolled in somebody else's course", () => {
      const lessonIds = lessonIdsOf(seedCurriculum(base.course.id, [2]));
      const second = seedSecondCourse();
      const otherLessons = lessonIdsOf(seedCurriculum(second.id, [2]));

      studentWhoStoppedAfter("Ours", base.course.id, lessonIds, 1);
      studentWhoStoppedAfter("Theirs", second.id, otherLessons, 2);

      const funnel = getCourseDropOff(base.course.id);

      expect(funnel.enrolledCount).toBe(1);
      expect(
        funnelLessons(funnel).map((lesson) => lesson.reachedCount)
      ).toEqual([1, 0]);
    });

    it("reports zeroes for a course nobody has enrolled in", () => {
      seedCurriculum(base.course.id, [2]);

      const funnel = getCourseDropOff(base.course.id);

      expect(funnel.enrolledCount).toBe(0);
      expect(
        funnelLessons(funnel).map((lesson) => lesson.reachedCount)
      ).toEqual([0, 0]);
    });

    it("has no modules at all for a course with no curriculum", () => {
      expect(getCourseDropOff(base.course.id).modules).toEqual([]);
    });
  });

  describe("listInstructorCourses", () => {
    it("lists the instructor's courses for the selector", () => {
      const second = seedSecondCourse();

      expect(listInstructorCourses(base.instructor.id)).toEqual([
        { courseId: second.id, title: "Second Course" },
        { courseId: base.course.id, title: "Test Course" },
      ]);
    });

    it("leaves out another instructor's courses", () => {
      const rival = seedRivalInstructor();

      expect(
        listInstructorCourses(base.instructor.id).map(
          (course) => course.courseId
        )
      ).not.toContain(rival.course.id);
    });

    it("spans every course when given a null instructor", () => {
      const rival = seedRivalInstructor();

      expect(
        listInstructorCourses(null).map((course) => course.courseId)
      ).toContain(rival.course.id);
    });
  });

  describe("getCourseQuizPassRates", () => {
    it("counts a retaken quiz once, on the student's best attempt", () => {
      const [{ lessons: courseLessons }] = seedCurriculum(base.course.id, [1]);
      const quiz = seedQuiz(courseLessons[0].id, "Fundamentals");
      const student = seedStudent("Retaker");

      // Failed, went away, came back and passed: one student, one pass.
      attempt(student.id, quiz.id, 0.4, daysAgo(5));
      attempt(student.id, quiz.id, 0.9, daysAgo(2));

      expect(getCourseQuizPassRates(base.course.id, "all")).toEqual([
        expect.objectContaining({
          quizId: quiz.id,
          title: "Fundamentals",
          studentCount: 1,
          passedCount: 1,
          passRatePercent: 100,
          averageBestScorePercent: 90,
        }),
      ]);
    });

    it("does not let a later worse attempt undo a pass", () => {
      const [{ lessons: courseLessons }] = seedCurriculum(base.course.id, [1]);
      const quiz = seedQuiz(courseLessons[0].id, "Fundamentals");
      const student = seedStudent("Careless");

      attempt(student.id, quiz.id, 0.9, daysAgo(5));
      attempt(student.id, quiz.id, 0.2, daysAgo(2));

      expect(getCourseQuizPassRates(base.course.id, "all")[0]).toMatchObject({
        studentCount: 1,
        passedCount: 1,
      });
    });

    it("averages the pass rate over students rather than over attempts", () => {
      const [{ lessons: courseLessons }] = seedCurriculum(base.course.id, [1]);
      const quiz = seedQuiz(courseLessons[0].id, "Fundamentals");

      // One student flailing through four attempts, one passing first time:
      // half the students pass, though only two attempts in five did.
      const flailer = seedStudent("Flailer");
      for (const score of [0.1, 0.2, 0.3, 0.4]) {
        attempt(flailer.id, quiz.id, score);
      }
      attempt(seedStudent("Ace").id, quiz.id, 1);

      expect(getCourseQuizPassRates(base.course.id, "all")[0]).toMatchObject({
        studentCount: 2,
        passedCount: 1,
        passRatePercent: 50,
      });
    });

    it("reports the verdict recorded on the best attempt, as the roster does", () => {
      const [{ lessons: courseLessons }] = seedCurriculum(base.course.id, [2]);
      const lenient = seedQuiz(courseLessons[0].id, "Lenient", 0.4);
      const strict = seedQuiz(courseLessons[1].id, "Strict", 0.9);
      const student = seedStudent("Middling");

      attempt(student.id, lenient.id, 0.5);
      attempt(student.id, strict.id, 0.5);

      const rates = getCourseQuizPassRates(base.course.id, "all");

      expect(rates.map((rate) => rate.title)).toEqual(["Lenient", "Strict"]);
      expect(rates[0]).toMatchObject({
        passingScorePercent: 40,
        passedCount: 1,
      });
      expect(rates[1]).toMatchObject({
        passingScorePercent: 90,
        passedCount: 0,
        passRatePercent: 0,
      });
    });

    it("lists a quiz nobody has attempted, with no rate at all", () => {
      const [{ lessons: courseLessons }] = seedCurriculum(base.course.id, [1]);
      const quiz = seedQuiz(courseLessons[0].id, "Untouched");

      expect(getCourseQuizPassRates(base.course.id, "all")).toEqual([
        expect.objectContaining({
          quizId: quiz.id,
          studentCount: 0,
          passedCount: 0,
          passRatePercent: null,
          averageBestScorePercent: null,
        }),
      ]);
    });

    it("has nothing to report for a course with no quizzes", () => {
      seedCurriculum(base.course.id, [2]);

      expect(getCourseQuizPassRates(base.course.id, "all")).toEqual([]);
    });

    it("names the lesson and module the quiz sits in, in course order", () => {
      const curriculum = seedCurriculum(base.course.id, [1, 1]);
      seedQuiz(curriculum[1].lessons[0].id, "Later quiz");
      seedQuiz(curriculum[0].lessons[0].id, "Earlier quiz");

      expect(getCourseQuizPassRates(base.course.id, "all")).toEqual([
        expect.objectContaining({
          title: "Earlier quiz",
          moduleTitle: "Module 1",
          lessonTitle: "Module 1 lesson 1",
        }),
        expect.objectContaining({
          title: "Later quiz",
          moduleTitle: "Module 2",
          lessonTitle: "Module 2 lesson 1",
        }),
      ]);
    });

    it("leaves out another course's quizzes", () => {
      const [{ lessons: ours }] = seedCurriculum(base.course.id, [1]);
      const second = seedSecondCourse();
      const [{ lessons: theirs }] = seedCurriculum(second.id, [1]);
      seedQuiz(ours[0].id, "Ours");
      seedQuiz(theirs[0].id, "Theirs");

      expect(
        getCourseQuizPassRates(base.course.id, "all").map((rate) => rate.title)
      ).toEqual(["Ours"]);
    });

    it("counts only the attempts made inside the range", () => {
      const [{ lessons: courseLessons }] = seedCurriculum(base.course.id, [1]);
      const quiz = seedQuiz(courseLessons[0].id, "Fundamentals");
      const student = seedStudent("Improver");

      // The old failure is outside the window, so the recent pass stands alone.
      attempt(student.id, quiz.id, 0.2, daysAgo(60));
      attempt(student.id, quiz.id, 0.8, daysAgo(2));
      attempt(seedStudent("Ancient").id, quiz.id, 0.9, daysAgo(60));

      expect(getCourseQuizPassRates(base.course.id, "7d")[0]).toMatchObject({
        studentCount: 1,
        passedCount: 1,
        averageBestScorePercent: 80,
      });
    });
  });

  describe("getCourseRevenueByCountry", () => {
    it("groups a course's sales by country, biggest earner first", () => {
      buyFrom(base.course.id, 5000, "US");
      buyFrom(base.course.id, 5000, "US");
      buyFrom(base.course.id, 2500, "IN");

      const breakdown = getCourseRevenueByCountry(base.course.id, "all");

      expect(breakdown.grossCents).toBe(12500);
      expect(breakdown.purchaseCount).toBe(3);
      expect(breakdown.rows).toEqual([
        expect.objectContaining({
          country: "US",
          purchaseCount: 2,
          grossCents: 10000,
          sharePercent: 80,
          averagePaidCents: 5000,
        }),
        expect.objectContaining({
          country: "IN",
          purchaseCount: 1,
          grossCents: 2500,
          sharePercent: 20,
          averagePaidCents: 2500,
        }),
      ]);
    });

    it("carries what the instructor keeps, not only what buyers paid", () => {
      buyFrom(base.course.id, 10000, "US");
      buyFrom(base.course.id, 2500, "IN");

      const breakdown = getCourseRevenueByCountry(base.course.id, "all");

      // The same 20% split as every other money figure on the page: a panel
      // about what a region is worth to the instructor has to say the net.
      expect(breakdown.netCents).toBe(10000);
      expect(breakdown.discountedNetCents).toBe(2000);
      expect(breakdown.rows[0].netCents).toBe(8000);
    });

    it("keeps purchases with no recorded country as their own row", () => {
      buyFrom(base.course.id, 6000, "GB");
      buyFrom(base.course.id, 4000, null);

      const breakdown = getCourseRevenueByCountry(base.course.id, "all");

      // Not dropped, and not folded into a country it did not come from: the
      // rows have to add up to the revenue the rest of the page reports.
      expect(breakdown.grossCents).toBe(10000);
      expect(breakdown.rows.map((row) => row.country)).toEqual(["GB", null]);
      expect(breakdown.rows[1]).toMatchObject({
        grossCents: 4000,
        sharePercent: 40,
        discountPercent: null,
      });
    });

    it("marks each country with the parity discount it currently gets", () => {
      buyFrom(base.course.id, 5000, "US");
      buyFrom(base.course.id, 2500, "IN");

      const byCountry = new Map(
        getCourseRevenueByCountry(base.course.id, "all").rows.map((row) => [
          row.country,
          row.discountPercent,
        ])
      );

      expect(byCountry.get("US")).toBe(0);
      expect(byCountry.get("IN")).toBe(50);
    });

    it("totals the revenue coming from discounted regions", () => {
      buyFrom(base.course.id, 5000, "US");
      buyFrom(base.course.id, 2500, "IN");
      buyFrom(base.course.id, 1500, "NG");
      buyFrom(base.course.id, 1000, null);

      const breakdown = getCourseRevenueByCountry(base.course.id, "all");

      // A purchase with no country is not counted as discounted — nothing is
      // known about it, and guessing would overstate the discounted share.
      expect(breakdown.discountedGrossCents).toBe(4000);
      expect(breakdown.discountedSharePercent).toBe(40);
    });

    it("counts only sales of the selected course", () => {
      const second = seedSecondCourse();
      buyFrom(base.course.id, 5000, "US");
      buyFrom(second.id, 9900, "US");

      expect(getCourseRevenueByCountry(base.course.id, "all").grossCents).toBe(
        5000
      );
    });

    it("counts only sales inside the range", () => {
      buyFrom(base.course.id, 5000, "US", daysAgo(2));
      buyFrom(base.course.id, 9900, "US", daysAgo(60));

      const breakdown = getCourseRevenueByCountry(base.course.id, "7d");

      expect(breakdown.grossCents).toBe(5000);
      expect(breakdown.purchaseCount).toBe(1);
    });

    it("reports zeroes, not NaN, for a course that has not sold", () => {
      expect(getCourseRevenueByCountry(base.course.id, "all")).toEqual({
        grossCents: 0,
        netCents: 0,
        purchaseCount: 0,
        discountedGrossCents: 0,
        discountedNetCents: 0,
        discountedSharePercent: 0,
        rows: [],
      });
    });
  });
});
