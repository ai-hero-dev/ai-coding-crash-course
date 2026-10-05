import { describe, it, expect, beforeEach, vi } from "vitest";
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

// Import after mock so the module picks up our test db
import { getCourseDetail } from "./analyticsService";

// ─── Local fixtures ───

let counter = 0;

function createStudent() {
  counter++;
  return testDb
    .insert(schema.users)
    .values({
      name: `Student ${counter}`,
      email: `student-${counter}@example.com`,
      role: schema.UserRole.Student,
    })
    .returning()
    .get();
}

/**
 * Adds modules and lessons to the base course. `shape` gives the lesson count
 * of each module. Returns the lesson ids in course order.
 */
function createCourseContent(shape: number[]): number[] {
  const lessonIds: number[] = [];
  shape.forEach((lessonCount, moduleIndex) => {
    const mod = testDb
      .insert(schema.modules)
      .values({
        courseId: base.course.id,
        title: `Module ${moduleIndex + 1}`,
        position: moduleIndex + 1,
      })
      .returning()
      .get();
    for (let i = 0; i < lessonCount; i++) {
      const lesson = testDb
        .insert(schema.lessons)
        .values({
          moduleId: mod.id,
          title: `Lesson ${lessonIds.length + 1}`,
          position: i + 1,
        })
        .returning()
        .get();
      lessonIds.push(lesson.id);
    }
  });
  return lessonIds;
}

function enroll(userId: number) {
  testDb
    .insert(schema.enrollments)
    .values({ userId, courseId: base.course.id })
    .run();
}

function recordProgress(
  userId: number,
  lessonId: number,
  status: schema.LessonProgressStatus = schema.LessonProgressStatus.Completed
) {
  testDb
    .insert(schema.lessonProgress)
    .values({
      userId,
      lessonId,
      status,
      completedAt:
        status === schema.LessonProgressStatus.Completed
          ? new Date().toISOString()
          : null,
    })
    .run();
}

/** An enrolled student who completed the given lessons. */
function enrolledStudent(completedLessonIds: number[]) {
  const student = createStudent();
  enroll(student.id);
  for (const lessonId of completedLessonIds) {
    recordProgress(student.id, lessonId);
  }
  return student;
}

function getDetail() {
  return getCourseDetail(base.course.id, "all");
}

beforeEach(() => {
  testDb = createTestDb();
  base = seedBaseData(testDb);
});

describe("getCourseDetail: progress", () => {
  it("averages lesson progress over enrollees and counts finishers separately", () => {
    const lessons = createCourseContent([2, 2]);
    // 100%, 50%, 25% and 0%: the average is 43.75%, but only one finished.
    enrolledStudent(lessons);
    enrolledStudent(lessons.slice(0, 2));
    enrolledStudent(lessons.slice(0, 1));
    enrolledStudent([]);

    const { progress } = getDetail();

    expect(progress).toEqual({
      enrolledCount: 4,
      averageProgressPercent: 44,
      finishedCount: 1,
    });
  });

  it("returns zeros, not NaN, for a course with no enrolled students", () => {
    const [first] = createCourseContent([2]);
    const visitor = createStudent();
    recordProgress(visitor.id, first);

    const { progress, funnel } = getDetail();

    expect(progress).toEqual({
      enrolledCount: 0,
      averageProgressPercent: 0,
      finishedCount: 0,
    });
    expect(funnel.enrolledCount).toBe(0);
    expect(funnel.modules[0].lessons.map((l) => l.reachedCount)).toEqual([
      0, 0,
    ]);
  });

  it("returns zeros for a course with no lessons", () => {
    enrolledStudent([]);

    const { progress, funnel } = getDetail();

    expect(progress.averageProgressPercent).toBe(0);
    expect(progress.finishedCount).toBe(0);
    expect(funnel.modules).toEqual([]);
  });
});

/** Every lesson of the funnel in course order, flattened out of its modules. */
function funnelLessons() {
  return getDetail().funnel.modules.flatMap((mod) => mod.lessons);
}

describe("getCourseDetail: drop-off funnel", () => {
  it("counts each lesson's students who reached at least that lesson", () => {
    const [first, second, third] = createCourseContent([3]);
    enrolledStudent([first, second, third]);
    const halfway = enrolledStudent([first]);
    recordProgress(halfway.id, second, schema.LessonProgressStatus.InProgress);
    enrolledStudent([first]);
    enrolledStudent([]);
    // Progress without an enrolment is not counted.
    const visitor = createStudent();
    recordProgress(visitor.id, third);

    expect(funnelLessons().map((lesson) => lesson.reachedCount)).toEqual([
      3, 2, 1,
    ]);
  });

  it("counts a student who skipped a lesson but continued as present at it", () => {
    const [first, second, third, fourth] = createCourseContent([4]);
    enrolledStudent([first, third, fourth]); // skipped the second lesson
    enrolledStudent([first, second]);

    const counts = funnelLessons().map((lesson) => lesson.reachedCount);

    expect(counts).toEqual([2, 2, 1, 1]);
    expect(funnelLessons()[1].dropCount).toBe(0);
  });

  it("only ever descends", () => {
    const lessons = createCourseContent([3, 3]);
    // Mixed, skipping progress: each student completes every other lesson
    // up to a different point.
    for (let furthest = 0; furthest < lessons.length; furthest++) {
      enrolledStudent(lessons.filter((_, i) => i <= furthest && i % 2 === 0));
      enrolledStudent(lessons.filter((_, i) => i <= furthest && i % 2 === 1));
    }

    const counts = funnelLessons().map((lesson) => lesson.reachedCount);

    counts.slice(1).forEach((count, i) => {
      expect(count).toBeLessThanOrEqual(counts[i]);
    });
  });

  it("shows each lesson's drop from the one before, and module subtotals", () => {
    const lessons = createCourseContent([2, 2]);
    // Furthest lesson reached: 4, 4, 3, 2, 2, 1, and one student who never
    // started.
    for (const furthest of [4, 4, 3, 2, 2, 1, 0]) {
      enrolledStudent(lessons.slice(0, furthest));
    }

    const { funnel } = getDetail();

    expect(funnel.enrolledCount).toBe(7);
    expect(
      funnel.modules.map((mod) => ({
        title: mod.title,
        reachedCount: mod.reachedCount,
        dropCount: mod.dropCount,
        lessons: mod.lessons.map((lesson) => [
          lesson.reachedCount,
          lesson.dropCount,
        ]),
      }))
    ).toEqual([
      {
        title: "Module 1",
        reachedCount: 6,
        dropCount: 2, // 7 enrolled -> 5 at the end of the module
        lessons: [
          [6, 1],
          [5, 1],
        ],
      },
      {
        title: "Module 2",
        reachedCount: 3,
        dropCount: 3, // 5 -> 2
        lessons: [
          [3, 2],
          [2, 1],
        ],
      },
    ]);
  });
});

// ─── Quiz fixtures ───

function createQuiz(lessonId: number, title = "Quiz") {
  return testDb
    .insert(schema.quizzes)
    .values({ lessonId, title, passingScore: 0.7 })
    .returning()
    .get();
}

function attempt(
  userId: number,
  quizId: number,
  score: number,
  attemptedAt = "2026-06-10T12:00:00.000Z"
) {
  testDb
    .insert(schema.quizAttempts)
    .values({ userId, quizId, score, passed: score >= 0.7, attemptedAt })
    .run();
}

describe("getCourseDetail: quiz pass rates", () => {
  it("counts a student who failed and then passed once, as passed", () => {
    const [lesson] = createCourseContent([1]);
    const quiz = createQuiz(lesson, "Basics quiz");
    const retaker = enrolledStudent([]);
    attempt(retaker.id, quiz.id, 0.4, "2026-06-01T12:00:00.000Z");
    attempt(retaker.id, quiz.id, 0.9, "2026-06-02T12:00:00.000Z");
    const failer = enrolledStudent([]);
    attempt(failer.id, quiz.id, 0.5);

    const { quizPassRates } = getDetail();

    expect(quizPassRates).toEqual([
      {
        quizId: quiz.id,
        title: "Basics quiz",
        lessonTitle: "Lesson 1",
        studentCount: 2,
        passedCount: 1,
        passRatePercent: 50,
      },
    ]);
  });

  it("uses only attempts in range, and gives an unattempted quiz no rate", () => {
    const [first, second] = createCourseContent([2]);
    const early = createQuiz(first, "Early quiz");
    const late = createQuiz(second, "Late quiz");
    const student = enrolledStudent([]);
    // The pass is 31 days old, so in the last 30 days only the fail counts.
    attempt(student.id, early.id, 1, "2026-05-15T11:59:59.000Z");
    attempt(student.id, early.id, 0.2, "2026-06-14T12:00:00.000Z");

    const { quizPassRates } = getCourseDetail(
      base.course.id,
      "30d",
      new Date("2026-06-15T12:00:00.000Z")
    );

    expect(
      quizPassRates.map((quiz) => [
        quiz.quizId,
        quiz.studentCount,
        quiz.passedCount,
        quiz.passRatePercent,
      ])
    ).toEqual([
      [early.id, 1, 0, 0],
      [late.id, 0, 0, null],
    ]);
  });

  it("returns no rows for a course without quizzes", () => {
    createCourseContent([2]);

    expect(getDetail().quizPassRates).toEqual([]);
  });
});

// ─── Purchase fixtures ───

function purchase(
  country: string | null,
  amountPaid: number,
  createdAt = "2026-06-10T12:00:00.000Z",
  courseId = base.course.id
) {
  const buyer = createStudent();
  testDb
    .insert(schema.purchases)
    .values({ userId: buyer.id, courseId, amountPaid, country, createdAt })
    .run();
}

describe("getCourseDetail: revenue by country", () => {
  it("sums revenue per buyer country, with no recorded country as its own bucket", () => {
    purchase("US", 10000);
    purchase("US", 10000);
    purchase("IN", 5000); // 50% off
    purchase("BR", 7000); // 30% off
    purchase(null, 3000);
    purchase(null, 1000);

    const { countryRevenue } = getDetail();

    expect(countryRevenue).toEqual({
      totalCents: 36000,
      discountedCents: 12000,
      purchaseCount: 6,
      countries: [
        {
          country: "US",
          purchaseCount: 2,
          revenueCents: 20000,
          discountLabel: "Full Price",
          discounted: false,
        },
        {
          country: "BR",
          purchaseCount: 1,
          revenueCents: 7000,
          discountLabel: "30% off",
          discounted: true,
        },
        {
          country: "IN",
          purchaseCount: 1,
          revenueCents: 5000,
          discountLabel: "50% off",
          discounted: true,
        },
        {
          country: null,
          purchaseCount: 2,
          revenueCents: 4000,
          discountLabel: null,
          discounted: false,
        },
      ],
    });
  });

  it("counts only this course's purchases in range, including one exactly on the edge", () => {
    const other = testDb
      .insert(schema.courses)
      .values({
        title: "Other",
        slug: "other",
        description: "Other course",
        salesCopy: "Other course",
        status: schema.CourseStatus.Published,
        instructorId: base.instructor.id,
        categoryId: base.category.id,
      })
      .returning()
      .get();
    purchase("US", 100, "2026-05-16T12:00:00.000Z"); // exactly 30 days ago
    purchase("US", 200, "2026-05-16T11:59:59.999Z"); // just outside
    purchase("US", 400, "2026-06-15T12:00:00.000Z", other.id);

    const { countryRevenue } = getCourseDetail(
      base.course.id,
      "30d",
      new Date("2026-06-15T12:00:00.000Z")
    );

    expect(countryRevenue.totalCents).toBe(100);
    expect(countryRevenue.purchaseCount).toBe(1);
  });

  it("shows no discount for any country when the course has PPP turned off", () => {
    testDb
      .update(schema.courses)
      .set({ pppEnabled: false })
      .where(eq(schema.courses.id, base.course.id))
      .run();
    purchase("IN", 10000);
    purchase("US", 10000);

    const { countryRevenue } = getDetail();

    expect(countryRevenue.discountedCents).toBe(0);
    expect(countryRevenue.countries).toEqual([
      {
        country: "IN",
        purchaseCount: 1,
        revenueCents: 10000,
        discountLabel: "Full Price",
        discounted: false,
      },
      {
        country: "US",
        purchaseCount: 1,
        revenueCents: 10000,
        discountLabel: "Full Price",
        discounted: false,
      },
    ]);
  });

  it("returns zeros and no countries for a course with no sales", () => {
    expect(getDetail().countryRevenue).toEqual({
      totalCents: 0,
      discountedCents: 0,
      purchaseCount: 0,
      countries: [],
    });
  });
});
