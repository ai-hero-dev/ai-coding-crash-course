import { eq, and, sql, gt, lt, gte, lte } from "drizzle-orm";
import { db } from "~/db";
import { lessons } from "~/db/schema";

// ─── Lesson Service ───
// Handles lesson CRUD and reordering within modules.
// Uses positional parameters (project convention).

export function getLessonById(id: number) {
  return db.select().from(lessons).where(eq(lessons.id, id)).get();
}

export function getLessonsByModule(moduleId: number) {
  return db
    .select()
    .from(lessons)
    .where(eq(lessons.moduleId, moduleId))
    .orderBy(lessons.position)
    .all();
}

export function getLessonCount(moduleId: number) {
  const result = db
    .select({ count: sql<number>`count(*)` })
    .from(lessons)
    .where(eq(lessons.moduleId, moduleId))
    .get();
  return result?.count ?? 0;
}

export function createLesson(
  moduleId: number,
  title: string,
  content: string | null,
  videoUrl: string | null,
  position: number | null,
  durationMinutes: number | null
) {
  const pos =
    position ??
    db
      .select({ max: sql<number>`coalesce(max(${lessons.position}), 0)` })
      .from(lessons)
      .where(eq(lessons.moduleId, moduleId))
      .get()!.max + 1;

  return db
    .insert(lessons)
    .values({
      moduleId,
      title,
      content,
      videoUrl,
      position: pos,
      durationMinutes,
    })
    .returning()
    .get();
}

export function updateLesson(
  id: number,
  title: string | null,
  content: string | null,
  videoUrl: string | null,
  durationMinutes: number | null,
  githubRepoUrl: string | null = null
) {
  const updates: Record<string, unknown> = {};
  if (title !== null) updates.title = title;
  if (content !== null) updates.content = content;
  if (videoUrl !== null) updates.videoUrl = videoUrl;
  if (durationMinutes !== null) updates.durationMinutes = durationMinutes;
  if (githubRepoUrl !== null) updates.githubRepoUrl = githubRepoUrl;

  if (Object.keys(updates).length === 0) {
    return getLessonById(id);
  }

  return db
    .update(lessons)
    .set(updates)
    .where(eq(lessons.id, id))
    .returning()
    .get();
}

export function updateLessonTitle(id: number, title: string) {
  return db
    .update(lessons)
    .set({ title })
    .where(eq(lessons.id, id))
    .returning()
    .get();
}

export function updateLessonContent(id: number, content: string) {
  return db
    .update(lessons)
    .set({ content })
    .where(eq(lessons.id, id))
    .returning()
    .get();
}

export function deleteLesson(id: number) {
  return db.delete(lessons).where(eq(lessons.id, id)).returning().get();
}

// ─── Reordering ───

export function moveLessonToPosition(lessonId: number, newPosition: number) {
  const lesson = getLessonById(lessonId);
  if (!lesson) return null;

  const oldPosition = lesson.position;
  if (oldPosition === newPosition) return lesson;

  if (newPosition > oldPosition) {
    // Moving down: shift items between old+1 and new up by 1
    db.update(lessons)
      .set({ position: sql`${lessons.position} - 1` })
      .where(
        and(
          eq(lessons.moduleId, lesson.moduleId),
          gt(lessons.position, oldPosition),
          lte(lessons.position, newPosition)
        )
      )
      .run();
  } else {
    // Moving up: shift items between new and old-1 down by 1
    db.update(lessons)
      .set({ position: sql`${lessons.position} + 1` })
      .where(
        and(
          eq(lessons.moduleId, lesson.moduleId),
          gte(lessons.position, newPosition),
          lt(lessons.position, oldPosition)
        )
      )
      .run();
  }

  return db
    .update(lessons)
    .set({ position: newPosition })
    .where(eq(lessons.id, lessonId))
    .returning()
    .get();
}

export function swapLessonPositions(lessonIdA: number, lessonIdB: number) {
  const lessonA = getLessonById(lessonIdA);
  const lessonB = getLessonById(lessonIdB);
  if (!lessonA || !lessonB) return null;

  db.update(lessons)
    .set({ position: lessonB.position })
    .where(eq(lessons.id, lessonIdA))
    .run();

  db.update(lessons)
    .set({ position: lessonA.position })
    .where(eq(lessons.id, lessonIdB))
    .run();

  return {
    a: { ...lessonA, position: lessonB.position },
    b: { ...lessonB, position: lessonA.position },
  };
}

export function reorderLessons(moduleId: number, lessonIds: number[]) {
  for (let i = 0; i < lessonIds.length; i++) {
    db.update(lessons)
      .set({ position: i + 1 })
      .where(and(eq(lessons.id, lessonIds[i]), eq(lessons.moduleId, moduleId)))
      .run();
  }
  return getLessonsByModule(moduleId);
}

/**
 * Move a lesson from one module to another at a specific position.
 * Closes the gap in the source module and opens a gap in the destination module.
 */
export function moveLessonToModule(
  lessonId: number,
  targetModuleId: number,
  targetPosition: number
) {
  const lesson = getLessonById(lessonId);
  if (!lesson) return null;

  const sourceModuleId = lesson.moduleId;

  // 1. Close the gap in the source module
  db.update(lessons)
    .set({ position: sql`${lessons.position} - 1` })
    .where(
      and(
        eq(lessons.moduleId, sourceModuleId),
        gt(lessons.position, lesson.position)
      )
    )
    .run();

  // 2. Open a gap in the destination module
  db.update(lessons)
    .set({ position: sql`${lessons.position} + 1` })
    .where(
      and(
        eq(lessons.moduleId, targetModuleId),
        gte(lessons.position, targetPosition)
      )
    )
    .run();

  // 3. Move the lesson to the target module at the target position
  return db
    .update(lessons)
    .set({ moduleId: targetModuleId, position: targetPosition })
    .where(eq(lessons.id, lessonId))
    .returning()
    .get();
}
