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
  return getCourseDetail({ courseId: base.course.id, range: "all" });
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
