import {
  eq,
  ne,
  or,
  and,
  isNull,
  notExists,
  sql,
  desc,
  asc,
  count,
} from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { db } from "~/db";
import {
  comments,
  courses,
  lessons,
  modules,
  users,
  UserRole,
} from "~/db/schema";
import { MIN_COMMENT_LENGTH, MAX_COMMENT_LENGTH } from "~/lib/comments";

// ─── Comment Service ───
// Lesson comments: a flat list of top-level questions, each with one level of
// replies. There is no stored "answered" flag — a question counts as answered
// when the course's own instructor (or an admin) has replied to it. Deriving it
// means the queue can never drift out of sync with the thread.
//
// Deletes are soft: a deleted top-level comment keeps its replies readable, so
// removing one doesn't destroy the context of the conversation around it.
//
// Uses positional parameters (project convention).

export type CommentAuthor = {
  id: number;
  name: string;
  avatarUrl: string | null;
  /** Owns the course this comment sits in. */
  isInstructor: boolean;
  isAdmin: boolean;
};

export type ThreadComment = {
  id: number;
  body: string;
  createdAt: string;
  editedAt: string | null;
  deleted: boolean;
  author: CommentAuthor;
  replies: ThreadComment[];
};

function assertValidBody(body: string) {
  const trimmed = body.trim();
  if (trimmed.length < MIN_COMMENT_LENGTH) {
    throw new Error("Comment cannot be empty");
  }
  if (trimmed.length > MAX_COMMENT_LENGTH) {
    throw new Error(
      `Comment must be ${MAX_COMMENT_LENGTH} characters or fewer`
    );
  }
  return trimmed;
}

/**
 * The course a lesson belongs to, via its module. Returns undefined when the
 * lesson doesn't exist.
 */
export function getCourseForLesson(lessonId: number) {
  return db
    .select({
      courseId: courses.id,
      courseTitle: courses.title,
      courseSlug: courses.slug,
      instructorId: courses.instructorId,
    })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .innerJoin(courses, eq(modules.courseId, courses.id))
    .where(eq(lessons.id, lessonId))
    .get();
}

export function getCommentById(commentId: number) {
  return db.select().from(comments).where(eq(comments.id, commentId)).get();
}

/**
 * Every comment on a lesson, oldest first, nested one level deep.
 *
 * Soft-deleted top-level comments are kept as tombstones (body blanked) when
 * they still have replies, and dropped entirely when they don't. Soft-deleted
 * replies are always dropped.
 */
export function getLessonThread(lessonId: number): ThreadComment[] {
  const course = getCourseForLesson(lessonId);
  if (!course) return [];

  const rows = db
    .select({
      id: comments.id,
      body: comments.body,
      parentId: comments.parentId,
      createdAt: comments.createdAt,
      editedAt: comments.editedAt,
      deletedAt: comments.deletedAt,
      authorId: users.id,
      authorName: users.name,
      authorAvatarUrl: users.avatarUrl,
      authorRole: users.role,
    })
    .from(comments)
    .innerJoin(users, eq(comments.userId, users.id))
    .where(eq(comments.lessonId, lessonId))
    .orderBy(asc(comments.createdAt), asc(comments.id))
    .all();

  const toThreadComment = (row: (typeof rows)[number]): ThreadComment => {
    const deleted = row.deletedAt !== null;
    return {
      id: row.id,
      body: deleted ? "" : row.body,
      createdAt: row.createdAt,
      editedAt: deleted ? null : row.editedAt,
      deleted,
      author: {
        id: row.authorId,
        name: row.authorName,
        avatarUrl: row.authorAvatarUrl,
        isInstructor: row.authorId === course.instructorId,
        isAdmin: row.authorRole === UserRole.Admin,
      },
      replies: [],
    };
  };

  const topLevel: ThreadComment[] = [];
  const byId = new Map<number, ThreadComment>();

  for (const row of rows) {
    if (row.parentId !== null) continue;
    const comment = toThreadComment(row);
    byId.set(comment.id, comment);
    topLevel.push(comment);
  }

  for (const row of rows) {
    if (row.parentId === null || row.deletedAt !== null) continue;
    byId.get(row.parentId)?.replies.push(toThreadComment(row));
  }

  // A deleted question with no replies left has nothing worth showing.
  return topLevel.filter((c) => !c.deleted || c.replies.length > 0);
}

export function getCommentCountForLesson(lessonId: number) {
  const result = db
    .select({ count: sql<number>`count(*)` })
    .from(comments)
    .where(and(eq(comments.lessonId, lessonId), isNull(comments.deletedAt)))
    .get();

  return result?.count ?? 0;
}

/**
 * Posts a comment. Pass a parentId to reply to a top-level comment — replies
 * are one level deep, so replying to a reply is rejected.
 */
export function createComment(
  userId: number,
  lessonId: number,
  parentId: number | null,
  body: string
) {
  const trimmed = assertValidBody(body);

  const course = getCourseForLesson(lessonId);
  if (!course) {
    throw new Error("Lesson not found");
  }

  if (parentId !== null) {
    const parent = getCommentById(parentId);
    if (!parent) {
      throw new Error("Parent comment not found");
    }
    if (parent.lessonId !== lessonId) {
      throw new Error("Parent comment belongs to a different lesson");
    }
    if (parent.parentId !== null) {
      throw new Error("Replies can only be one level deep");
    }
  }

  return db
    .insert(comments)
    .values({ userId, lessonId, parentId, body: trimmed })
    .returning()
    .get();
}

/**
 * Edits a comment. Only its author may edit, and only while it isn't deleted.
 */
export function updateComment(commentId: number, userId: number, body: string) {
  const trimmed = assertValidBody(body);

  const existing = getCommentById(commentId);
  if (!existing) {
    throw new Error("Comment not found");
  }
  if (existing.deletedAt !== null) {
    throw new Error("Comment has been deleted");
  }
  if (existing.userId !== userId) {
    throw new Error("You can only edit your own comments");
  }

  return db
    .update(comments)
    .set({ body: trimmed, editedAt: new Date().toISOString() })
    .where(eq(comments.id, commentId))
    .returning()
    .get();
}

/**
 * Soft-deletes a comment. The author can delete their own; pass isStaff for the
 * course's instructor or an admin, who can delete anyone's.
 */
export function deleteComment(
  commentId: number,
  userId: number,
  isStaff: boolean
) {
  const existing = getCommentById(commentId);
  if (!existing) {
    throw new Error("Comment not found");
  }
  if (existing.userId !== userId && !isStaff) {
    throw new Error("You can only delete your own comments");
  }
  if (existing.deletedAt !== null) {
    return existing;
  }

  return db
    .update(comments)
    .set({ deletedAt: new Date().toISOString() })
    .where(eq(comments.id, commentId))
    .returning()
    .get();
}

export type QueuedQuestion = {
  id: number;
  body: string;
  createdAt: string;
  lessonId: number;
  lessonTitle: string;
  courseTitle: string;
  courseSlug: string;
  authorId: number;
  authorName: string;
  authorAvatarUrl: string | null;
};

/**
 * Questions still waiting on an answer, newest first.
 *
 * A question qualifies when it is top-level, not deleted, not written by staff,
 * and has no reply from the course's instructor or an admin. Pass null for
 * instructorId to span every course (admins); pass an id to scope to the
 * courses that instructor owns.
 */
/**
 * What makes a question unanswered, as a where-clause plus the author alias it
 * refers to. Shared so that counting the queue and listing it can never drift
 * apart on what counts as waiting.
 */
function unansweredScope(instructorId: number | null) {
  const author = alias(users, "author");
  const reply = alias(comments, "reply");
  const replyAuthor = alias(users, "reply_author");

  // Correlated: matches a live reply, by staff, to the outer question.
  const staffReply = db
    .select({ one: sql`1` })
    .from(reply)
    .innerJoin(replyAuthor, eq(replyAuthor.id, reply.userId))
    .where(
      and(
        eq(reply.parentId, comments.id),
        isNull(reply.deletedAt),
        or(
          eq(replyAuthor.role, UserRole.Admin),
          eq(reply.userId, courses.instructorId)
        )
      )
    );

  const conditions = [
    isNull(comments.parentId),
    isNull(comments.deletedAt),
    // Staff asking their own question shouldn't queue up as work for themselves.
    ne(author.role, UserRole.Admin),
    ne(comments.userId, courses.instructorId),
    notExists(staffReply),
  ];

  if (instructorId !== null) {
    conditions.push(eq(courses.instructorId, instructorId));
  }

  return { author, where: and(...conditions) };
}

export type UnansweredCounts = {
  /** Asked on or after `since` — everything, when `since` is null. */
  inRange: number;
  older: number;
};

/**
 * How many questions are waiting, split at `since` (an ISO timestamp, or null
 * for no split at all).
 *
 * The two numbers come back together because the older ones matter most: a
 * question that has gone unanswered for months is the urgent one, and a
 * dashboard that windowed it away would hide exactly the work it exists to
 * surface.
 */
export function getUnansweredCounts(
  instructorId: number | null,
  since: string | null
): UnansweredCounts {
  const { author, where } = unansweredScope(instructorId);

  const row = db
    .select({
      inRange:
        since === null
          ? count(comments.id)
          : sql<number>`sum(case when ${comments.createdAt} >= ${since} then 1 else 0 end)`,
      total: count(comments.id),
    })
    .from(comments)
    .innerJoin(author, eq(comments.userId, author.id))
    .innerJoin(lessons, eq(comments.lessonId, lessons.id))
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .innerJoin(courses, eq(modules.courseId, courses.id))
    .where(where)
    .get();

  // sum() is null over an empty set; count() is already 0.
  const inRange = Number(row?.inRange ?? 0);

  return { inRange, older: (row?.total ?? 0) - inRange };
}

export function getUnansweredQuestions(
  instructorId: number | null
): QueuedQuestion[] {
  const { author, where } = unansweredScope(instructorId);

  return db
    .select({
      id: comments.id,
      body: comments.body,
      createdAt: comments.createdAt,
      lessonId: lessons.id,
      lessonTitle: lessons.title,
      courseTitle: courses.title,
      courseSlug: courses.slug,
      authorId: author.id,
      authorName: author.name,
      authorAvatarUrl: author.avatarUrl,
    })
    .from(comments)
    .innerJoin(author, eq(comments.userId, author.id))
    .innerJoin(lessons, eq(comments.lessonId, lessons.id))
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .innerJoin(courses, eq(modules.courseId, courses.id))
    .where(where)
    .orderBy(desc(comments.createdAt), desc(comments.id))
    .all();
}
