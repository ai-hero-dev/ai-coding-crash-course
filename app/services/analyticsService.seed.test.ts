import { describe, it, expect, beforeAll, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import * as schema from "~/db/schema";
import { seed } from "../../scripts/seed";

// The real seed, run into an in-memory database, checked against the drop-off
// cliffs it plants (see the comment above FURTHEST_REACHED in
// scripts/seed.ts).

let testDb: ReturnType<typeof drizzle<typeof schema>>;

vi.mock("~/db", () => ({
  get db() {
    return testDb;
  },
}));

// Import after mock so the module picks up our test db
import { getCourseDetail } from "./analyticsService";

beforeAll(async () => {
  const sqlite = new Database(":memory:");
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  await seed(sqlite);
  log.mockRestore();
  testDb = drizzle(sqlite, { schema });
});

function funnelFor(courseTitle: string) {
  const course = testDb
    .select({ id: schema.courses.id })
    .from(schema.courses)
    .where(eq(schema.courses.title, courseTitle))
    .get();
  if (!course) throw new Error(`No seeded course "${courseTitle}"`);
  const { funnel } = getCourseDetail(course.id, "all");
  const lessons = funnel.modules.flatMap((mod) => mod.lessons);
  return { funnel, lessons };
}

/** The lessons with the biggest drops, biggest first. */
function biggestDrops(
  lessons: ReturnType<typeof funnelFor>["lessons"],
  count: number
) {
  return [...lessons]
    .sort((a, b) => b.dropCount - a.dropCount)
    .slice(0, count)
    .map((lesson) => lesson.title);
}

describe("getCourseDetail on the seed data", () => {
  it("finds the planted cliffs in Introduction to TypeScript", () => {
    const { funnel, lessons } = funnelFor("Introduction to TypeScript");

    expect(funnel.enrolledCount).toBe(33);
    expect(lessons.map((lesson) => lesson.reachedCount)).toEqual([
      33, 33, 32, 28, 27, 24, 24, 23, 12, 12, 12, 12, 12, 12, 12, 12, 7, 7, 6,
    ]);
    expect(biggestDrops(lessons, 2)).toEqual([
      "Generics Basics",
      "TypeScript with React",
    ]);
  });

  it("finds the planted cliff in Building REST APIs with Node.js", () => {
    const { funnel, lessons } = funnelFor("Building REST APIs with Node.js");

    expect(funnel.enrolledCount).toBe(33);
    expect(lessons.map((lesson) => lesson.reachedCount)).toEqual([
      33, 33, 29, 28, 28, 28, 28, 25, 24, 24, 24, 23, 9, 8, 8, 6, 6, 6, 6, 6,
    ]);
    expect(biggestDrops(lessons, 1)).toEqual(["JWT Authentication"]);
  });

  it("descends monotonically on every seeded course", () => {
    const courses = testDb
      .select({ title: schema.courses.title })
      .from(schema.courses)
      .all();

    for (const { title } of courses) {
      const counts = funnelFor(title).lessons.map((l) => l.reachedCount);
      counts.slice(1).forEach((count, i) => {
        expect(count).toBeLessThanOrEqual(counts[i]);
      });
    }
  });
});
