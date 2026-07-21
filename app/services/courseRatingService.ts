import { eq, and, inArray, sql } from "drizzle-orm";
import { db } from "~/db";
import { courseRatings, courses } from "~/db/schema";
import { MIN_RATING, MAX_RATING } from "~/lib/ratings";

// ─── Course Rating Service ───
// Handles star ratings (1–5, no written review) left by students on courses.
// One rating per user per course — rating again updates the existing row.
// Uses positional parameters (project convention).

export type CourseRatingSummary = {
  average: number | null;
  count: number;
};

const EMPTY_SUMMARY: CourseRatingSummary = { average: null, count: 0 };

function assertValidRating(rating: number) {
  if (!Number.isInteger(rating) || rating < MIN_RATING || rating > MAX_RATING) {
    throw new Error(
      `Rating must be a whole number between ${MIN_RATING} and ${MAX_RATING}`
    );
  }
}

export function findRating(userId: number, courseId: number) {
  return db
    .select()
    .from(courseRatings)
    .where(
      and(eq(courseRatings.userId, userId), eq(courseRatings.courseId, courseId))
    )
    .get();
}

export function getRatingsForCourse(courseId: number) {
  return db
    .select()
    .from(courseRatings)
    .where(eq(courseRatings.courseId, courseId))
    .all();
}

/**
 * Average (rounded to 1dp) and total count of ratings for a single course.
 * Returns a null average when the course has no ratings yet.
 */
export function getCourseRatingSummary(courseId: number): CourseRatingSummary {
  const result = db
    .select({
      average: sql<number | null>`avg(${courseRatings.rating})`,
      count: sql<number>`count(*)`,
    })
    .from(courseRatings)
    .where(eq(courseRatings.courseId, courseId))
    .get();

  if (!result || result.count === 0 || result.average === null) {
    return EMPTY_SUMMARY;
  }

  return {
    average: Math.round(result.average * 10) / 10,
    count: result.count,
  };
}

/**
 * Rating summaries for many courses in one query — for list pages that would
 * otherwise fire a query per course.
 */
export function getCourseRatingSummaries(
  courseIds: number[]
): Map<number, CourseRatingSummary> {
  const summaries = new Map<number, CourseRatingSummary>();

  if (courseIds.length === 0) return summaries;

  const rows = db
    .select({
      courseId: courseRatings.courseId,
      average: sql<number | null>`avg(${courseRatings.rating})`,
      count: sql<number>`count(*)`,
    })
    .from(courseRatings)
    .where(inArray(courseRatings.courseId, courseIds))
    .groupBy(courseRatings.courseId)
    .all();

  for (const row of rows) {
    summaries.set(row.courseId, {
      average: row.average === null ? null : Math.round(row.average * 10) / 10,
      count: row.count,
    });
  }

  for (const courseId of courseIds) {
    if (!summaries.has(courseId)) {
      summaries.set(courseId, EMPTY_SUMMARY);
    }
  }

  return summaries;
}

/**
 * Creates the user's rating for a course, or updates it if they've already
 * rated. Returns the stored rating row.
 */
export function rateCourse(userId: number, courseId: number, rating: number) {
  assertValidRating(rating);

  const course = db
    .select({ id: courses.id })
    .from(courses)
    .where(eq(courses.id, courseId))
    .get();

  if (!course) {
    throw new Error("Course not found");
  }

  const existing = findRating(userId, courseId);

  if (existing) {
    return db
      .update(courseRatings)
      .set({ rating, updatedAt: new Date().toISOString() })
      .where(eq(courseRatings.id, existing.id))
      .returning()
      .get();
  }

  return db
    .insert(courseRatings)
    .values({ userId, courseId, rating })
    .returning()
    .get();
}

export function deleteRating(userId: number, courseId: number) {
  return db
    .delete(courseRatings)
    .where(
      and(eq(courseRatings.userId, userId), eq(courseRatings.courseId, courseId))
    )
    .returning()
    .get();
}
