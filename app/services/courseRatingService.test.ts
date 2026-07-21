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
import {
  rateCourse,
  findRating,
  deleteRating,
  getRatingsForCourse,
  getCourseRatingSummary,
  getCourseRatingSummaries,
} from "./courseRatingService";

function createStudent(name: string, email: string) {
  return testDb
    .insert(schema.users)
    .values({ name, email, role: schema.UserRole.Student })
    .returning()
    .get();
}

function createCourse(title: string, slug: string) {
  return testDb
    .insert(schema.courses)
    .values({
      title,
      slug,
      description: "Another course",
      instructorId: base.instructor.id,
      categoryId: base.category.id,
      status: schema.CourseStatus.Published,
    })
    .returning()
    .get();
}

describe("courseRatingService", () => {
  beforeEach(() => {
    testDb = createTestDb();
    base = seedBaseData(testDb);
  });

  describe("rateCourse", () => {
    it("stores a rating for a user and course", () => {
      const rating = rateCourse(base.user.id, base.course.id, 4);

      expect(rating.userId).toBe(base.user.id);
      expect(rating.courseId).toBe(base.course.id);
      expect(rating.rating).toBe(4);
    });

    it("updates the existing rating instead of adding a second one", () => {
      rateCourse(base.user.id, base.course.id, 2);
      const updated = rateCourse(base.user.id, base.course.id, 5);

      expect(updated.rating).toBe(5);
      expect(getRatingsForCourse(base.course.id)).toHaveLength(1);
    });

    it.each([0, 6, -1, 2.5])("rejects a rating of %s", (value) => {
      expect(() => rateCourse(base.user.id, base.course.id, value)).toThrowError(
        "Rating must be a whole number between 1 and 5"
      );
    });

    it("accepts the boundary values 1 and 5", () => {
      expect(rateCourse(base.user.id, base.course.id, 1).rating).toBe(1);
      expect(rateCourse(base.user.id, base.course.id, 5).rating).toBe(5);
    });

    it("throws when the course does not exist", () => {
      expect(() => rateCourse(base.user.id, 9999, 3)).toThrowError(
        "Course not found"
      );
    });
  });

  describe("findRating", () => {
    it("returns the user's rating when it exists", () => {
      rateCourse(base.user.id, base.course.id, 3);

      expect(findRating(base.user.id, base.course.id)!.rating).toBe(3);
    });

    it("returns undefined when the user has not rated the course", () => {
      expect(findRating(base.user.id, base.course.id)).toBeUndefined();
    });
  });

  describe("deleteRating", () => {
    it("removes the user's rating", () => {
      rateCourse(base.user.id, base.course.id, 3);
      deleteRating(base.user.id, base.course.id);

      expect(findRating(base.user.id, base.course.id)).toBeUndefined();
    });
  });

  describe("getCourseRatingSummary", () => {
    it("returns a null average and zero count when there are no ratings", () => {
      expect(getCourseRatingSummary(base.course.id)).toEqual({
        average: null,
        count: 0,
      });
    });

    it("averages all ratings for the course", () => {
      const student2 = createStudent("Student Two", "student2@example.com");

      rateCourse(base.user.id, base.course.id, 5);
      rateCourse(student2.id, base.course.id, 3);

      expect(getCourseRatingSummary(base.course.id)).toEqual({
        average: 4,
        count: 2,
      });
    });

    it("rounds the average to one decimal place", () => {
      const student2 = createStudent("Student Two", "student2@example.com");
      const student3 = createStudent("Student Three", "student3@example.com");

      rateCourse(base.user.id, base.course.id, 5);
      rateCourse(student2.id, base.course.id, 4);
      rateCourse(student3.id, base.course.id, 4);

      // 13 / 3 = 4.333...
      expect(getCourseRatingSummary(base.course.id).average).toBe(4.3);
    });

    it("ignores ratings left on other courses", () => {
      const other = createCourse("Other Course", "other-course");

      rateCourse(base.user.id, base.course.id, 5);
      rateCourse(base.user.id, other.id, 1);

      expect(getCourseRatingSummary(base.course.id)).toEqual({
        average: 5,
        count: 1,
      });
    });
  });

  describe("getCourseRatingSummaries", () => {
    it("returns an empty map for an empty list of course ids", () => {
      expect(getCourseRatingSummaries([]).size).toBe(0);
    });

    it("returns a summary per course, including unrated ones", () => {
      const other = createCourse("Other Course", "other-course");
      const student2 = createStudent("Student Two", "student2@example.com");

      rateCourse(base.user.id, base.course.id, 4);
      rateCourse(student2.id, base.course.id, 2);

      const summaries = getCourseRatingSummaries([base.course.id, other.id]);

      expect(summaries.get(base.course.id)).toEqual({ average: 3, count: 2 });
      expect(summaries.get(other.id)).toEqual({ average: null, count: 0 });
    });
  });
});
