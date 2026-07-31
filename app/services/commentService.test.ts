import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { eq } from "drizzle-orm";

let testDb: ReturnType<typeof createTestDb>;
let base: ReturnType<typeof seedBaseData>;
let lesson: { id: number };

vi.mock("~/db", () => ({
  get db() {
    return testDb;
  },
}));

// Import after mock so the module picks up our test db
import {
  createComment,
  updateComment,
  deleteComment,
  getCommentById,
  getLessonThread,
  getCommentCountForLesson,
  getUnansweredQuestions,
  getUnansweredCounts,
  getCourseForLesson,
} from "./commentService";

function createUser(name: string, email: string, role: schema.UserRole) {
  return testDb
    .insert(schema.users)
    .values({ name, email, role })
    .returning()
    .get();
}

function createLesson(courseId: number, title: string) {
  const mod = testDb
    .insert(schema.modules)
    .values({ courseId, title: "Module", position: 1 })
    .returning()
    .get();

  return testDb
    .insert(schema.lessons)
    .values({ moduleId: mod.id, title, position: 1 })
    .returning()
    .get();
}

describe("commentService", () => {
  beforeEach(() => {
    testDb = createTestDb();
    base = seedBaseData(testDb);
    lesson = createLesson(base.course.id, "Test Lesson");
  });

  describe("createComment", () => {
    it("stores a top-level comment", () => {
      const comment = createComment(base.user.id, lesson.id, null, "How?");

      expect(comment.userId).toBe(base.user.id);
      expect(comment.lessonId).toBe(lesson.id);
      expect(comment.parentId).toBeNull();
      expect(comment.body).toBe("How?");
      expect(comment.deletedAt).toBeNull();
    });

    it("trims surrounding whitespace", () => {
      expect(createComment(base.user.id, lesson.id, null, "  hi  ").body).toBe(
        "hi"
      );
    });

    it.each(["", "   ", "\n"])("rejects a body of %j", (body) => {
      expect(() =>
        createComment(base.user.id, lesson.id, null, body)
      ).toThrowError("Comment cannot be empty");
    });

    it("rejects a body over 5000 characters", () => {
      expect(() =>
        createComment(base.user.id, lesson.id, null, "a".repeat(5001))
      ).toThrowError("Comment must be 5000 characters or fewer");
    });

    it("accepts a body of exactly 5000 characters", () => {
      const body = "a".repeat(5000);
      expect(createComment(base.user.id, lesson.id, null, body).body).toBe(
        body
      );
    });

    it("throws when the lesson does not exist", () => {
      expect(() => createComment(base.user.id, 9999, null, "hi")).toThrowError(
        "Lesson not found"
      );
    });

    it("stores a reply to a top-level comment", () => {
      const question = createComment(base.user.id, lesson.id, null, "How?");
      const reply = createComment(
        base.instructor.id,
        lesson.id,
        question.id,
        "Like this"
      );

      expect(reply.parentId).toBe(question.id);
    });

    it("rejects a reply to a reply — replies are one level deep", () => {
      const question = createComment(base.user.id, lesson.id, null, "How?");
      const reply = createComment(
        base.instructor.id,
        lesson.id,
        question.id,
        "Like this"
      );

      expect(() =>
        createComment(base.user.id, lesson.id, reply.id, "Thanks")
      ).toThrowError("Replies can only be one level deep");
    });

    it("rejects a reply whose parent is on another lesson", () => {
      const other = createLesson(base.course.id, "Other Lesson");
      const question = createComment(base.user.id, other.id, null, "How?");

      expect(() =>
        createComment(base.user.id, lesson.id, question.id, "Reply")
      ).toThrowError("Parent comment belongs to a different lesson");
    });

    it("throws when the parent does not exist", () => {
      expect(() =>
        createComment(base.user.id, lesson.id, 9999, "Reply")
      ).toThrowError("Parent comment not found");
    });
  });

  describe("updateComment", () => {
    it("changes the body and records editedAt", () => {
      const comment = createComment(base.user.id, lesson.id, null, "Frist");
      expect(comment.editedAt).toBeNull();

      const updated = updateComment(comment.id, base.user.id, "First");

      expect(updated.body).toBe("First");
      expect(updated.editedAt).not.toBeNull();
    });

    it("refuses to edit someone else's comment", () => {
      const comment = createComment(base.user.id, lesson.id, null, "Mine");

      expect(() =>
        updateComment(comment.id, base.instructor.id, "Yours")
      ).toThrowError("You can only edit your own comments");
    });

    it("refuses to edit a deleted comment", () => {
      const comment = createComment(base.user.id, lesson.id, null, "Mine");
      deleteComment(comment.id, base.user.id, false);

      expect(() =>
        updateComment(comment.id, base.user.id, "Back again")
      ).toThrowError("Comment has been deleted");
    });

    it("rejects an empty body", () => {
      const comment = createComment(base.user.id, lesson.id, null, "Mine");

      expect(() => updateComment(comment.id, base.user.id, "  ")).toThrowError(
        "Comment cannot be empty"
      );
    });
  });

  describe("deleteComment", () => {
    it("soft-deletes rather than removing the row", () => {
      const comment = createComment(base.user.id, lesson.id, null, "Oops");
      deleteComment(comment.id, base.user.id, false);

      const stored = getCommentById(comment.id);
      expect(stored).toBeDefined();
      expect(stored!.deletedAt).not.toBeNull();
    });

    it("refuses to delete someone else's comment without staff rights", () => {
      const student = createUser(
        "Other",
        "other@example.com",
        schema.UserRole.Student
      );
      const comment = createComment(base.user.id, lesson.id, null, "Mine");

      expect(() => deleteComment(comment.id, student.id, false)).toThrowError(
        "You can only delete your own comments"
      );
    });

    it("lets staff delete anyone's comment", () => {
      const comment = createComment(base.user.id, lesson.id, null, "Spam");
      const deleted = deleteComment(comment.id, base.instructor.id, true);

      expect(deleted.deletedAt).not.toBeNull();
    });

    it("is idempotent", () => {
      const comment = createComment(base.user.id, lesson.id, null, "Oops");
      const first = deleteComment(comment.id, base.user.id, false);
      const second = deleteComment(comment.id, base.user.id, false);

      expect(second.deletedAt).toBe(first.deletedAt);
    });
  });

  describe("getLessonThread", () => {
    it("returns an empty array for a lesson with no comments", () => {
      expect(getLessonThread(lesson.id)).toEqual([]);
    });

    it("returns an empty array for a lesson that does not exist", () => {
      expect(getLessonThread(9999)).toEqual([]);
    });

    it("nests replies under their parent", () => {
      const question = createComment(base.user.id, lesson.id, null, "How?");
      createComment(base.instructor.id, lesson.id, question.id, "Like this");

      const thread = getLessonThread(lesson.id);

      expect(thread).toHaveLength(1);
      expect(thread[0].body).toBe("How?");
      expect(thread[0].replies).toHaveLength(1);
      expect(thread[0].replies[0].body).toBe("Like this");
    });

    it("orders top-level comments oldest first", () => {
      createComment(base.user.id, lesson.id, null, "First");
      createComment(base.user.id, lesson.id, null, "Second");

      expect(getLessonThread(lesson.id).map((c) => c.body)).toEqual([
        "First",
        "Second",
      ]);
    });

    it("badges the course's own instructor", () => {
      createComment(base.instructor.id, lesson.id, null, "Welcome");

      expect(getLessonThread(lesson.id)[0].author.isInstructor).toBe(true);
    });

    it("does not badge an instructor who does not own the course", () => {
      const other = createUser(
        "Other Instructor",
        "other-instructor@example.com",
        schema.UserRole.Instructor
      );
      createComment(other.id, lesson.id, null, "Hello");

      const author = getLessonThread(lesson.id)[0].author;
      expect(author.isInstructor).toBe(false);
      expect(author.isAdmin).toBe(false);
    });

    it("badges admins", () => {
      const admin = createUser(
        "Admin",
        "admin@example.com",
        schema.UserRole.Admin
      );
      createComment(admin.id, lesson.id, null, "Hello");

      expect(getLessonThread(lesson.id)[0].author.isAdmin).toBe(true);
    });

    it("flags edited comments", () => {
      const comment = createComment(base.user.id, lesson.id, null, "Frist");
      updateComment(comment.id, base.user.id, "First");

      expect(getLessonThread(lesson.id)[0].editedAt).not.toBeNull();
    });

    it("does not flag unedited comments", () => {
      createComment(base.user.id, lesson.id, null, "First");

      expect(getLessonThread(lesson.id)[0].editedAt).toBeNull();
    });

    it("drops a deleted question that has no replies", () => {
      const comment = createComment(base.user.id, lesson.id, null, "Oops");
      deleteComment(comment.id, base.user.id, false);

      expect(getLessonThread(lesson.id)).toEqual([]);
    });

    it("keeps a deleted question with replies as a blanked tombstone", () => {
      const question = createComment(base.user.id, lesson.id, null, "Oops");
      createComment(base.instructor.id, lesson.id, question.id, "Answer");
      deleteComment(question.id, base.user.id, false);

      const thread = getLessonThread(lesson.id);

      expect(thread).toHaveLength(1);
      expect(thread[0].deleted).toBe(true);
      expect(thread[0].body).toBe("");
      expect(thread[0].replies).toHaveLength(1);
    });

    it("drops deleted replies entirely", () => {
      const question = createComment(base.user.id, lesson.id, null, "How?");
      const reply = createComment(
        base.instructor.id,
        lesson.id,
        question.id,
        "Wrong answer"
      );
      deleteComment(reply.id, base.instructor.id, false);

      expect(getLessonThread(lesson.id)[0].replies).toEqual([]);
    });

    it("ignores comments on other lessons", () => {
      const other = createLesson(base.course.id, "Other Lesson");
      createComment(base.user.id, other.id, null, "Elsewhere");

      expect(getLessonThread(lesson.id)).toEqual([]);
    });
  });

  describe("getCommentCountForLesson", () => {
    it("counts questions and replies, excluding deleted ones", () => {
      const question = createComment(base.user.id, lesson.id, null, "How?");
      createComment(base.instructor.id, lesson.id, question.id, "Like this");
      const spam = createComment(base.user.id, lesson.id, null, "Spam");
      deleteComment(spam.id, base.user.id, false);

      expect(getCommentCountForLesson(lesson.id)).toBe(2);
    });
  });

  describe("getUnansweredQuestions", () => {
    it("lists a student question with no reply", () => {
      createComment(base.user.id, lesson.id, null, "How?");

      const queue = getUnansweredQuestions(base.instructor.id);

      expect(queue).toHaveLength(1);
      expect(queue[0].body).toBe("How?");
      expect(queue[0].lessonTitle).toBe("Test Lesson");
      expect(queue[0].courseSlug).toBe("test-course");
      expect(queue[0].authorName).toBe("Test User");
    });

    it("clears a question once the owning instructor replies", () => {
      const question = createComment(base.user.id, lesson.id, null, "How?");
      createComment(base.instructor.id, lesson.id, question.id, "Like this");

      expect(getUnansweredQuestions(base.instructor.id)).toEqual([]);
    });

    it("clears a question once an admin replies", () => {
      const admin = createUser(
        "Admin",
        "admin@example.com",
        schema.UserRole.Admin
      );
      const question = createComment(base.user.id, lesson.id, null, "How?");
      createComment(admin.id, lesson.id, question.id, "Like this");

      expect(getUnansweredQuestions(base.instructor.id)).toEqual([]);
    });

    it("does not clear a question when only another student replies", () => {
      const student = createUser(
        "Other",
        "other@example.com",
        schema.UserRole.Student
      );
      const question = createComment(base.user.id, lesson.id, null, "How?");
      createComment(student.id, lesson.id, question.id, "Me too");

      expect(getUnansweredQuestions(base.instructor.id)).toHaveLength(1);
    });

    it("does not clear a question when the staff reply was deleted", () => {
      const question = createComment(base.user.id, lesson.id, null, "How?");
      const reply = createComment(
        base.instructor.id,
        lesson.id,
        question.id,
        "Oops"
      );
      deleteComment(reply.id, base.instructor.id, false);

      expect(getUnansweredQuestions(base.instructor.id)).toHaveLength(1);
    });

    it("ignores questions written by the owning instructor", () => {
      createComment(base.instructor.id, lesson.id, null, "Announcement");

      expect(getUnansweredQuestions(base.instructor.id)).toEqual([]);
    });

    it("ignores questions written by an admin", () => {
      const admin = createUser(
        "Admin",
        "admin@example.com",
        schema.UserRole.Admin
      );
      createComment(admin.id, lesson.id, null, "Notice");

      expect(getUnansweredQuestions(base.instructor.id)).toEqual([]);
    });

    it("ignores deleted questions", () => {
      const question = createComment(base.user.id, lesson.id, null, "Spam");
      deleteComment(question.id, base.instructor.id, true);

      expect(getUnansweredQuestions(base.instructor.id)).toEqual([]);
    });

    it("ignores replies — only top-level questions queue up", () => {
      const question = createComment(base.user.id, lesson.id, null, "How?");
      createComment(base.instructor.id, lesson.id, question.id, "Like this");
      createComment(base.user.id, lesson.id, question.id, "Still stuck");

      expect(getUnansweredQuestions(base.instructor.id)).toEqual([]);
    });

    it("scopes to the courses an instructor owns", () => {
      const otherInstructor = createUser(
        "Other Instructor",
        "other-instructor@example.com",
        schema.UserRole.Instructor
      );
      const otherCourse = testDb
        .insert(schema.courses)
        .values({
          title: "Other Course",
          slug: "other-course",
          description: "Another",
          salesCopy: "Sales copy.",
          instructorId: otherInstructor.id,
          categoryId: base.category.id,
          status: schema.CourseStatus.Published,
        })
        .returning()
        .get();
      const otherLesson = createLesson(otherCourse.id, "Other Lesson");

      createComment(base.user.id, lesson.id, null, "Mine");
      createComment(base.user.id, otherLesson.id, null, "Theirs");

      expect(
        getUnansweredQuestions(base.instructor.id).map((q) => q.body)
      ).toEqual(["Mine"]);
      expect(
        getUnansweredQuestions(otherInstructor.id).map((q) => q.body)
      ).toEqual(["Theirs"]);
    });

    it("spans every course when given a null instructor id", () => {
      const otherInstructor = createUser(
        "Other Instructor",
        "other-instructor@example.com",
        schema.UserRole.Instructor
      );
      const otherCourse = testDb
        .insert(schema.courses)
        .values({
          title: "Other Course",
          slug: "other-course",
          description: "Another",
          salesCopy: "Sales copy.",
          instructorId: otherInstructor.id,
          categoryId: base.category.id,
          status: schema.CourseStatus.Published,
        })
        .returning()
        .get();
      const otherLesson = createLesson(otherCourse.id, "Other Lesson");

      createComment(base.user.id, lesson.id, null, "Mine");
      createComment(base.user.id, otherLesson.id, null, "Theirs");

      expect(getUnansweredQuestions(null)).toHaveLength(2);
    });

    it("orders newest first", () => {
      createComment(base.user.id, lesson.id, null, "Older");
      createComment(base.user.id, lesson.id, null, "Newer");

      expect(
        getUnansweredQuestions(base.instructor.id).map((q) => q.body)
      ).toEqual(["Newer", "Older"]);
    });
  });

  describe("getUnansweredCounts", () => {
    /** Moves a question back in time — createComment always stamps it now. */
    function backdate(commentId: number, createdAt: string) {
      testDb
        .update(schema.comments)
        .set({ createdAt })
        .where(eq(schema.comments.id, commentId))
        .run();
    }

    const LAST_WEEK = "2026-06-08T12:00:00.000Z";

    it("counts every waiting question when nothing splits them", () => {
      createComment(base.user.id, lesson.id, null, "How?");
      createComment(base.user.id, lesson.id, null, "Why?");

      expect(getUnansweredCounts(base.instructor.id, null)).toEqual({
        inRange: 2,
        older: 0,
      });
    });

    it("splits the queue at the given timestamp", () => {
      const stale = createComment(base.user.id, lesson.id, null, "Ancient");
      backdate(stale.id, "2020-01-01T00:00:00.000Z");
      createComment(base.user.id, lesson.id, null, "Fresh");

      expect(getUnansweredCounts(base.instructor.id, LAST_WEEK)).toEqual({
        inRange: 1,
        older: 1,
      });
    });

    it("agrees with the queue it summarises", () => {
      createComment(base.user.id, lesson.id, null, "How?");
      const answered = createComment(base.user.id, lesson.id, null, "Answered");
      createComment(base.instructor.id, lesson.id, answered.id, "Like this");

      const counts = getUnansweredCounts(base.instructor.id, null);

      expect(counts.inRange + counts.older).toBe(
        getUnansweredQuestions(base.instructor.id).length
      );
    });

    it("counts zero rather than NaN with an empty queue", () => {
      expect(getUnansweredCounts(base.instructor.id, LAST_WEEK)).toEqual({
        inRange: 0,
        older: 0,
      });
    });

    it("scopes to the courses an instructor owns", () => {
      const otherInstructor = createUser(
        "Other Instructor",
        "other-instructor@example.com",
        schema.UserRole.Instructor
      );
      const otherCourse = testDb
        .insert(schema.courses)
        .values({
          title: "Other Course",
          slug: "other-course",
          description: "Another",
          salesCopy: "Sales copy.",
          instructorId: otherInstructor.id,
          categoryId: base.category.id,
          status: schema.CourseStatus.Published,
        })
        .returning()
        .get();

      createComment(base.user.id, lesson.id, null, "Mine");
      createComment(
        base.user.id,
        createLesson(otherCourse.id, "Other Lesson").id,
        null,
        "Theirs"
      );

      expect(getUnansweredCounts(base.instructor.id, null).inRange).toBe(1);
      expect(getUnansweredCounts(null, null).inRange).toBe(2);
    });
  });

  describe("getCourseForLesson", () => {
    it("resolves the course through the lesson's module", () => {
      const course = getCourseForLesson(lesson.id);

      expect(course!.courseId).toBe(base.course.id);
      expect(course!.instructorId).toBe(base.instructor.id);
    });

    it("returns undefined for a lesson that does not exist", () => {
      expect(getCourseForLesson(9999)).toBeUndefined();
    });
  });
});
