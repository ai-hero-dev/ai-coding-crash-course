import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";

let testDb: ReturnType<typeof createTestDb>;
let base: ReturnType<typeof seedBaseData>;

vi.mock("~/db", () => ({
  get db() {
    return testDb;
  },
}));

// Import after mock so the module picks up our test db
import { getAnalyticsCourses, getOverview } from "./analyticsService";

const NOW = new Date("2026-06-15T12:00:00.000Z");

function daysBefore(days: number, from: Date = NOW): string {
  return new Date(from.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

// ─── Local fixtures ───

let counter = 0;

function createInstructor(name = "Other Instructor") {
  counter++;
  return testDb
    .insert(schema.users)
    .values({
      name,
      email: `instructor-${counter}@example.com`,
      role: schema.UserRole.Instructor,
    })
    .returning()
    .get();
}

function createCourse(
  instructorId: number,
  status: schema.CourseStatus = schema.CourseStatus.Published
) {
  counter++;
  return testDb
    .insert(schema.courses)
    .values({
      title: `Course ${counter}`,
      slug: `course-${counter}`,
      description: "A course",
      salesCopy: "Sales copy",
      instructorId,
      categoryId: base.category.id,
      status,
    })
    .returning()
    .get();
}

function createPurchase(
  courseId: number,
  amountPaid: number,
  createdAt: string
) {
  return testDb
    .insert(schema.purchases)
    .values({
      userId: base.user.id,
      courseId,
      amountPaid,
      country: "US",
      createdAt,
    })
    .returning()
    .get();
}

beforeEach(() => {
  testDb = createTestDb();
  base = seedBaseData(testDb);
});

describe("getAnalyticsCourses", () => {
  it("lists only the instructor's courses, by title", () => {
    const other = createInstructor();
    createCourse(other.id);
    testDb
      .insert(schema.courses)
      .values({
        title: "A First Course",
        slug: "a-first-course",
        description: "A course",
        salesCopy: "Sales copy",
        instructorId: base.instructor.id,
        categoryId: base.category.id,
        status: schema.CourseStatus.Draft,
      })
      .run();

    const courses = getAnalyticsCourses(base.instructor.id);

    expect(courses.map((course) => course.title)).toEqual([
      "A First Course",
      "Test Course",
    ]);
  });

  it("lists every course when the instructor filter is null", () => {
    const other = createInstructor();
    createCourse(other.id);

    expect(getAnalyticsCourses(null)).toHaveLength(2);
  });

  it("returns an empty list for an instructor with no courses", () => {
    const newcomer = createInstructor("Newcomer");

    expect(getAnalyticsCourses(newcomer.id)).toEqual([]);
  });
});

describe("getOverview", () => {
  describe("revenue", () => {
    it("attributes purchases to the instructor who owns the course", () => {
      const other = createInstructor();
      const otherCourse = createCourse(other.id);
      createPurchase(base.course.id, 5000, daysBefore(1));
      createPurchase(base.course.id, 2500, daysBefore(2));
      createPurchase(otherCourse.id, 9900, daysBefore(1));

      const overview = getOverview({
        instructorId: base.instructor.id,
        range: "all",
        now: NOW,
      });

      expect(overview.revenue.grossCents).toBe(7500);
    });

    it("spans every instructor when the instructor filter is null", () => {
      const other = createInstructor();
      const otherCourse = createCourse(other.id);
      createPurchase(base.course.id, 5000, daysBefore(1));
      createPurchase(otherCourse.id, 9900, daysBefore(1));

      const overview = getOverview({
        instructorId: null,
        range: "all",
        now: NOW,
      });

      expect(overview.revenue.grossCents).toBe(14900);
    });

    it("takes a 20% platform fee and leaves the rest as net", () => {
      createPurchase(base.course.id, 10000, daysBefore(1));

      const { revenue } = getOverview({
        instructorId: base.instructor.id,
        range: "all",
        now: NOW,
      });

      expect(revenue).toEqual({
        grossCents: 10000,
        feeCents: 2000,
        netCents: 8000,
      });
    });

    it("rounds the fee to whole cents and keeps fee + net equal to gross", () => {
      // 20% of 1003 is 200.6 → fee rounds to 201, net is the remainder.
      createPurchase(base.course.id, 1003, daysBefore(1));

      const { revenue } = getOverview({
        instructorId: base.instructor.id,
        range: "all",
        now: NOW,
      });

      expect(revenue).toEqual({
        grossCents: 1003,
        feeCents: 201,
        netCents: 802,
      });
    });
  });

  describe("range", () => {
    // One purchase in each bucket, with distinct amounts so any subset
    // has a unique total.
    beforeEach(() => {
      createPurchase(base.course.id, 1, daysBefore(3)); // inside 7d
      createPurchase(base.course.id, 10, daysBefore(20)); // inside 30d
      createPurchase(base.course.id, 100, daysBefore(60)); // inside 90d
      createPurchase(base.course.id, 1000, daysBefore(200)); // all time only
    });

    it.each([
      ["7d", 1],
      ["30d", 11],
      ["90d", 111],
      ["all", 1111],
    ] as const)(
      "%s returns only purchases inside the range",
      (range, gross) => {
        const { revenue } = getOverview({
          instructorId: base.instructor.id,
          range,
          now: NOW,
        });

        expect(revenue.grossCents).toBe(gross);
      }
    );
  });

  describe("revenue over time", () => {
    it("buckets a short range by day, with a zero for each day without sales", () => {
      // NOW is 2026-06-15T12:00Z, so the 7d range starts 2026-06-08T12:00Z.
      createPurchase(base.course.id, 300, "2026-06-14T09:00:00.000Z");
      createPurchase(base.course.id, 200, "2026-06-14T18:00:00.000Z");
      createPurchase(base.course.id, 700, "2026-06-10T10:00:00.000Z");
      createPurchase(base.course.id, 999, "2026-06-01T10:00:00.000Z"); // outside

      const { revenueOverTime } = getOverview({
        instructorId: base.instructor.id,
        range: "7d",
        now: NOW,
      });

      expect(revenueOverTime).toEqual([
        { period: "2026-06-08", grossCents: 0 },
        { period: "2026-06-09", grossCents: 0 },
        { period: "2026-06-10", grossCents: 700 },
        { period: "2026-06-11", grossCents: 0 },
        { period: "2026-06-12", grossCents: 0 },
        { period: "2026-06-13", grossCents: 0 },
        { period: "2026-06-14", grossCents: 500 },
        { period: "2026-06-15", grossCents: 0 },
      ]);
    });

    it("buckets all time by month, from the first sale to now", () => {
      createPurchase(base.course.id, 100, "2026-03-20T10:00:00.000Z");
      createPurchase(base.course.id, 250, "2026-05-02T10:00:00.000Z");
      createPurchase(base.course.id, 50, "2026-05-30T10:00:00.000Z");

      const { revenueOverTime } = getOverview({
        instructorId: base.instructor.id,
        range: "all",
        now: NOW,
      });

      expect(revenueOverTime).toEqual([
        { period: "2026-03", grossCents: 100 },
        { period: "2026-04", grossCents: 0 },
        { period: "2026-05", grossCents: 300 },
        { period: "2026-06", grossCents: 0 },
      ]);
    });

    it("only counts the scoped instructor's sales", () => {
      const other = createInstructor();
      const otherCourse = createCourse(other.id);
      createPurchase(base.course.id, 300, "2026-06-14T09:00:00.000Z");
      createPurchase(otherCourse.id, 5000, "2026-06-14T09:00:00.000Z");

      const { revenueOverTime } = getOverview({
        instructorId: base.instructor.id,
        range: "7d",
        now: NOW,
      });

      expect(
        revenueOverTime.find((point) => point.period === "2026-06-14")
      ).toEqual({ period: "2026-06-14", grossCents: 300 });
    });
  });

  describe("instructor with no data", () => {
    it("returns zeroes and an empty series rather than throwing or NaN", () => {
      const newcomer = createInstructor("Newcomer");
      createPurchase(base.course.id, 5000, daysBefore(1));

      const overview = getOverview({
        instructorId: newcomer.id,
        range: "all",
        now: NOW,
      });

      expect(overview).toMatchObject({
        hasPublishedCourse: false,
        revenue: { grossCents: 0, feeCents: 0, netCents: 0 },
        revenueOverTime: [],
      });
    });

    it("gives a dated range a zero for each day", () => {
      const newcomer = createInstructor("Newcomer");

      const { revenueOverTime } = getOverview({
        instructorId: newcomer.id,
        range: "7d",
        now: NOW,
      });

      expect(revenueOverTime).toHaveLength(8);
      expect(revenueOverTime.every((p) => p.grossCents === 0)).toBe(true);
    });
  });

  describe("hasPublishedCourse", () => {
    it("is true when the instructor has a published course", () => {
      const overview = getOverview({
        instructorId: base.instructor.id,
        range: "all",
        now: NOW,
      });

      expect(overview.hasPublishedCourse).toBe(true);
    });

    it("is false when the instructor only has drafts", () => {
      const drafter = createInstructor("Drafter");
      createCourse(drafter.id, schema.CourseStatus.Draft);

      const overview = getOverview({
        instructorId: drafter.id,
        range: "all",
        now: NOW,
      });

      expect(overview.hasPublishedCourse).toBe(false);
    });
  });

  describe("range cutoff boundary", () => {
    it("includes a purchase made exactly on the cutoff", () => {
      createPurchase(base.course.id, 60000, daysBefore(30));
      createPurchase(base.course.id, 10000, daysBefore(5));

      const { revenue } = getOverview({
        instructorId: base.instructor.id,
        range: "30d",
        now: NOW,
      });

      expect(revenue.grossCents).toBe(70000);
    });

    it("excludes a purchase made one millisecond before the cutoff", () => {
      const justBefore = new Date(
        new Date(daysBefore(30)).getTime() - 1
      ).toISOString();
      createPurchase(base.course.id, 60000, justBefore);
      createPurchase(base.course.id, 10000, daysBefore(5));

      const { revenue } = getOverview({
        instructorId: base.instructor.id,
        range: "30d",
        now: NOW,
      });

      expect(revenue.grossCents).toBe(10000);
    });
  });
});
