import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { eq } from "drizzle-orm";

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

// ─── Overview: buyers, students, leaderboard, questions, ratings ───

function createStudent(name: string) {
  counter++;
  return testDb
    .insert(schema.users)
    .values({
      name,
      email: `student-${counter}@example.com`,
      role: schema.UserRole.Student,
    })
    .returning()
    .get();
}

function enroll(userId: number, courseId: number, enrolledAt: string) {
  testDb
    .insert(schema.enrollments)
    .values({ userId, courseId, enrolledAt })
    .run();
}

/** An individual purchase: the buyer pays for one seat and enrols. */
function buyAndEnroll(
  userId: number,
  courseId: number,
  amountPaid: number,
  createdAt: string
) {
  testDb
    .insert(schema.purchases)
    .values({ userId, courseId, amountPaid, country: "US", createdAt })
    .run();
  enroll(userId, courseId, createdAt);
}

/**
 * A team purchase: one purchase row, one coupon per seat. The buyer is not
 * enrolled.
 */
function buyTeamSeats(
  buyerId: number,
  courseId: number,
  amountPaid: number,
  seats: number,
  createdAt: string
) {
  const team = testDb.insert(schema.teams).values({}).returning().get();
  const purchase = testDb
    .insert(schema.purchases)
    .values({ userId: buyerId, courseId, amountPaid, country: "US", createdAt })
    .returning()
    .get();
  const coupons = Array.from({ length: seats }, () => {
    counter++;
    return testDb
      .insert(schema.coupons)
      .values({
        teamId: team.id,
        courseId,
        code: `SEAT-${counter}`,
        purchaseId: purchase.id,
        createdAt,
      })
      .returning()
      .get();
  });
  return { purchase, coupons };
}

/** Redeems a seat coupon: the redeemer enrols, with no purchase row. */
function redeem(
  coupon: typeof schema.coupons.$inferSelect,
  userId: number,
  at: string
) {
  testDb
    .update(schema.coupons)
    .set({ redeemedByUserId: userId, redeemedAt: at })
    .where(eq(schema.coupons.id, coupon.id))
    .run();
  enroll(userId, coupon.courseId, at);
}

describe("getOverview audience", () => {
  it("counts buyers and enrolled students separately when teams buy seats", () => {
    const solo = createStudent("Solo");
    const manager = createStudent("Manager");
    const [ann, bob] = [createStudent("Ann"), createStudent("Bob")];
    buyAndEnroll(solo.id, base.course.id, 5000, daysBefore(2));
    const team = buyTeamSeats(
      manager.id,
      base.course.id,
      30000,
      3,
      daysBefore(2)
    );
    redeem(team.coupons[0], ann.id, daysBefore(1));
    redeem(team.coupons[1], bob.id, daysBefore(1));

    const { audience } = getOverview({
      instructorId: base.instructor.id,
      range: "all",
      now: NOW,
    });

    // Buyers: Solo and Manager. Students: Solo, Ann and Bob.
    expect(audience.buyers).toBe(2);
    expect(audience.students).toBe(3);
  });

  it("traces a seat redeemer's revenue back to the team purchase that minted the seat", () => {
    const solo = createStudent("Solo");
    const manager = createStudent("Manager");
    const [ann, bob] = [createStudent("Ann"), createStudent("Bob")];
    buyAndEnroll(solo.id, base.course.id, 5000, daysBefore(2));
    // 3 seats for $300: each seat is worth $100.
    const team = buyTeamSeats(
      manager.id,
      base.course.id,
      30000,
      3,
      daysBefore(2)
    );
    redeem(team.coupons[0], ann.id, daysBefore(1));
    redeem(team.coupons[1], bob.id, daysBefore(1));

    const { audience } = getOverview({
      instructorId: base.instructor.id,
      range: "all",
      now: NOW,
    });

    // Solo $50 + Ann $100 + Bob $100 = $250 over 3 students. The unredeemed
    // third seat belongs to no student.
    expect(audience.studentRevenueCents).toBe(25000);
    expect(audience.revenuePerStudentCents).toBe(8333);
  });

  it("gives a student who enrolled free no revenue", () => {
    const freeloader = createStudent("Freeloader");
    enroll(freeloader.id, base.course.id, daysBefore(1));

    const { audience } = getOverview({
      instructorId: base.instructor.id,
      range: "all",
      now: NOW,
    });

    expect(audience).toMatchObject({
      students: 1,
      studentRevenueCents: 0,
      revenuePerStudentCents: 0,
    });
  });
});

describe("getOverview topBuyers", () => {
  it("ranks buyers by total spend across the instructor's courses, top ten only", () => {
    const secondCourse = createCourse(base.instructor.id);
    const buyers = Array.from({ length: 12 }, (_, i) =>
      createStudent(`Buyer ${i + 1}`)
    );
    // Buyer n spends n dollars on the main course.
    buyers.forEach((buyer, i) =>
      buyAndEnroll(buyer.id, base.course.id, (i + 1) * 100, daysBefore(3))
    );
    // Buyer 1 also spends $20 on the second course: $21 in total, the top.
    buyAndEnroll(buyers[0].id, secondCourse.id, 2000, daysBefore(3));

    const { topBuyers } = getOverview({
      instructorId: base.instructor.id,
      range: "all",
      now: NOW,
    });

    expect(
      topBuyers.map((buyer) => [buyer.name, buyer.totalSpentCents])
    ).toEqual([
      ["Buyer 1", 2100],
      ["Buyer 12", 1200],
      ["Buyer 11", 1100],
      ["Buyer 10", 1000],
      ["Buyer 9", 900],
      ["Buyer 8", 800],
      ["Buyer 7", 700],
      ["Buyer 6", 600],
      ["Buyer 5", 500],
      ["Buyer 4", 400],
    ]);
  });

  it("flags a team buyer who never enrolled, with seats bought and seats unused", () => {
    const manager = createStudent("Manager");
    const solo = createStudent("Solo");
    const ann = createStudent("Ann");
    buyAndEnroll(solo.id, base.course.id, 5000, daysBefore(2));
    const team = buyTeamSeats(
      manager.id,
      base.course.id,
      50000,
      5,
      daysBefore(2)
    );
    redeem(team.coupons[0], ann.id, daysBefore(1));
    redeem(team.coupons[1], solo.id, daysBefore(1));

    const { topBuyers } = getOverview({
      instructorId: base.instructor.id,
      range: "all",
      now: NOW,
    });

    expect(topBuyers).toEqual([
      {
        userId: manager.id,
        name: "Manager",
        email: manager.email,
        totalSpentCents: 50000,
        isTeamBuyer: true,
        seats: 5,
        unredeemedSeats: 3,
        enrolled: false,
      },
      {
        userId: solo.id,
        name: "Solo",
        email: solo.email,
        totalSpentCents: 5000,
        isTeamBuyer: false,
        seats: 0,
        unredeemedSeats: 0,
        enrolled: true,
      },
    ]);
  });

  it("only counts purchases inside the range and the instructor's scope", () => {
    const other = createInstructor();
    const otherCourse = createCourse(other.id);
    const buyer = createStudent("Buyer");
    buyAndEnroll(buyer.id, base.course.id, 1000, daysBefore(3));
    buyAndEnroll(buyer.id, base.course.id, 7000, daysBefore(60));
    buyAndEnroll(buyer.id, otherCourse.id, 9000, daysBefore(3));

    const { topBuyers } = getOverview({
      instructorId: base.instructor.id,
      range: "30d",
      now: NOW,
    });

    expect(topBuyers.map((row) => row.totalSpentCents)).toEqual([1000]);
  });
});

describe("getOverview seats", () => {
  it("counts team seats sold and the ones never redeemed", () => {
    const [m1, m2, ann] = [
      createStudent("M1"),
      createStudent("M2"),
      createStudent("Ann"),
    ];
    const first = buyTeamSeats(m1.id, base.course.id, 30000, 3, daysBefore(4));
    buyTeamSeats(m2.id, base.course.id, 20000, 2, daysBefore(4));
    redeem(first.coupons[2], ann.id, daysBefore(1));

    const { seats } = getOverview({
      instructorId: base.instructor.id,
      range: "all",
      now: NOW,
    });

    expect(seats).toEqual({ sold: 5, unredeemed: 4 });
  });
});

function createLesson(courseId: number) {
  const module = testDb
    .insert(schema.modules)
    .values({ courseId, title: "Module", position: 1 })
    .returning()
    .get();
  return testDb
    .insert(schema.lessons)
    .values({ moduleId: module.id, title: "Lesson", position: 1 })
    .returning()
    .get();
}

function ask(
  lessonId: number,
  userId: number,
  createdAt: string,
  parentId: number | null = null
) {
  return testDb
    .insert(schema.comments)
    .values({ lessonId, userId, body: "Question?", createdAt, parentId })
    .returning()
    .get();
}

describe("getOverview unansweredQuestions", () => {
  it("counts open questions asked in range on the instructor's courses", () => {
    const lesson = createLesson(base.course.id);
    const otherLesson = createLesson(createCourse(createInstructor().id).id);
    ask(lesson.id, base.user.id, daysBefore(2)); // open, in range
    ask(lesson.id, base.user.id, daysBefore(60)); // open, out of 30d range
    const answered = ask(lesson.id, base.user.id, daysBefore(3));
    ask(lesson.id, base.instructor.id, daysBefore(1), answered.id);
    ask(otherLesson.id, base.user.id, daysBefore(2)); // another instructor's

    const scope = { instructorId: base.instructor.id, now: NOW };

    expect(getOverview({ ...scope, range: "30d" }).unansweredQuestions).toBe(1);
    expect(getOverview({ ...scope, range: "all" }).unansweredQuestions).toBe(2);
  });
});

function rate(courseId: number, rating: number, at: string) {
  const rater = createStudent("Rater");
  testDb
    .insert(schema.courseRatings)
    .values({
      userId: rater.id,
      courseId,
      rating,
      createdAt: at,
      updatedAt: at,
    })
    .run();
}

describe("getOverview ratings", () => {
  it("averages ratings given in range, per course and overall", () => {
    const unrated = createCourse(base.instructor.id);
    createCourse(base.instructor.id, schema.CourseStatus.Draft);
    const otherCourse = createCourse(createInstructor().id);
    rate(base.course.id, 5, daysBefore(1));
    rate(base.course.id, 4, daysBefore(2));
    rate(base.course.id, 4, daysBefore(3));
    rate(base.course.id, 1, daysBefore(60)); // outside 30d
    rate(otherCourse.id, 1, daysBefore(1)); // another instructor's

    const { ratings } = getOverview({
      instructorId: base.instructor.id,
      range: "30d",
      now: NOW,
    });

    // 13 stars over 3 ratings = 4.33 → 4.3. Drafts cannot be rated: left out.
    expect(ratings).toEqual({
      average: 4.3,
      count: 3,
      courses: [
        { courseId: unrated.id, title: unrated.title, average: null, count: 0 },
        {
          courseId: base.course.id,
          title: "Test Course",
          average: 4.3,
          count: 3,
        },
      ],
    });
  });
});

describe("getOverview for an instructor with no data", () => {
  it("returns empty panels rather than throwing or NaN", () => {
    const newcomer = createInstructor("Newcomer");

    const overview = getOverview({
      instructorId: newcomer.id,
      range: "all",
      now: NOW,
    });

    expect(overview).toMatchObject({
      audience: {
        buyers: 0,
        students: 0,
        studentRevenueCents: 0,
        revenuePerStudentCents: 0,
      },
      topBuyers: [],
      seats: { sold: 0, unredeemed: 0 },
      unansweredQuestions: 0,
      ratings: { average: null, count: 0, courses: [] },
    });
  });
});
