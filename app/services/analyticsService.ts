import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  ne,
  sql,
  type SQL,
} from "drizzle-orm";
import { db } from "~/db";
import { alias } from "drizzle-orm/sqlite-core";
import {
  CourseStatus,
  LessonProgressStatus,
  coupons,
  courseRatings,
  courses,
  enrollments,
  lessonProgress,
  lessons,
  modules,
  purchases,
  users,
} from "~/db/schema";
import { PLATFORM_FEE_RATE, type AnalyticsRange } from "~/lib/analytics";
import { getUnansweredQuestions } from "~/services/commentService";

export type { AnalyticsRange };

export interface AnalyticsScope {
  instructorId: number | null;
  range: AnalyticsRange;
  now?: Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const RANGE_DAYS: Record<AnalyticsRange, number | null> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
  all: null,
};

/**
 * The earliest timestamp inside the range, as an ISO string, or null for all
 * time. The cutoff is INCLUSIVE: a row made exactly `days` ago is in range.
 * Timestamps are ISO strings, so string comparison orders them correctly.
 */
function resolveCutoff(scope: AnalyticsScope): string | null {
  const days = RANGE_DAYS[scope.range];
  if (days === null) return null;
  const now = scope.now ?? new Date();
  return new Date(now.getTime() - days * DAY_MS).toISOString();
}

/** Filters for purchases joined to courses: instructor scope and range. */
function purchaseConditions(scope: AnalyticsScope): SQL[] {
  const conditions: SQL[] = [];
  if (scope.instructorId !== null) {
    conditions.push(eq(courses.instructorId, scope.instructorId));
  }
  const cutoff = resolveCutoff(scope);
  if (cutoff !== null) {
    conditions.push(gte(purchases.createdAt, cutoff));
  }
  return conditions;
}

function getRevenue(scope: AnalyticsScope) {
  const row = db
    .select({
      gross: sql<number>`coalesce(sum(${purchases.amountPaid}), 0)`,
    })
    .from(purchases)
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(and(...purchaseConditions(scope)))
    .get();

  const grossCents = row?.gross ?? 0;
  // Round the fee, then derive net from it, so fee + net always equals gross.
  const feeCents = Math.round(grossCents * PLATFORM_FEE_RATE);
  return { grossCents, feeCents, netCents: grossCents - feeCents };
}

export interface RevenuePoint {
  /** UTC day ("2026-06-14") for dated ranges, UTC month ("2026-06") for all time. */
  period: string;
  grossCents: number;
}

type Granularity = "day" | "month";

// ISO timestamps: the first 10 chars are the UTC day, the first 7 the month.
const PERIOD_LENGTH: Record<Granularity, number> = { day: 10, month: 7 };

function nextPeriod(period: string, granularity: Granularity): string {
  if (granularity === "day") {
    const date = new Date(`${period}T00:00:00.000Z`);
    return new Date(date.getTime() + DAY_MS).toISOString().slice(0, 10);
  }
  const [year, month] = period.split("-").map(Number);
  return new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 7);
}

/**
 * Gross revenue per period, with a zero for each period without sales, from
 * the range start (or the first sale, for all time) up to now.
 */
function getRevenueOverTime(scope: AnalyticsScope): RevenuePoint[] {
  const granularity: Granularity = scope.range === "all" ? "month" : "day";
  const length = PERIOD_LENGTH[granularity];
  const periodExpr = sql<string>`substr(${purchases.createdAt}, 1, ${length})`;

  const rows = db
    .select({
      period: periodExpr,
      gross: sql<number>`sum(${purchases.amountPaid})`,
    })
    .from(purchases)
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(and(...purchaseConditions(scope)))
    .groupBy(periodExpr)
    .orderBy(periodExpr)
    .all();

  const cutoff = resolveCutoff(scope);
  const first = cutoff?.slice(0, length) ?? rows[0]?.period;
  if (first === undefined) return [];

  const last = (scope.now ?? new Date()).toISOString().slice(0, length);
  const grossByPeriod = new Map(rows.map((row) => [row.period, row.gross]));

  const points: RevenuePoint[] = [];
  for (
    let period = first;
    period <= last;
    period = nextPeriod(period, granularity)
  ) {
    points.push({ period, grossCents: grossByPeriod.get(period) ?? 0 });
  }
  return points;
}

export interface AnalyticsCourse {
  id: number;
  title: string;
  status: CourseStatus;
}

/**
 * The courses in scope, by title — the options of the Course detail picker.
 * Pass null to list every course on the platform (admins).
 */
export function getAnalyticsCourses(
  instructorId: number | null
): AnalyticsCourse[] {
  return db
    .select({ id: courses.id, title: courses.title, status: courses.status })
    .from(courses)
    .where(
      instructorId === null ? undefined : eq(courses.instructorId, instructorId)
    )
    .orderBy(asc(courses.title))
    .all();
}

function hasPublishedCourse(instructorId: number | null): boolean {
  const conditions: SQL[] = [eq(courses.status, CourseStatus.Published)];
  if (instructorId !== null) {
    conditions.push(eq(courses.instructorId, instructorId));
  }
  const row = db
    .select({ id: courses.id })
    .from(courses)
    .where(and(...conditions))
    .limit(1)
    .get();
  return row !== undefined;
}

// ─── Overview: buyers, students, leaderboard, questions, ratings ───

/** Filters for enrollments joined to courses: instructor scope and range. */
function enrollmentConditions(scope: AnalyticsScope): SQL[] {
  const conditions: SQL[] = [];
  if (scope.instructorId !== null) {
    conditions.push(eq(courses.instructorId, scope.instructorId));
  }
  const cutoff = resolveCutoff(scope);
  if (cutoff !== null) {
    conditions.push(gte(enrollments.enrolledAt, cutoff));
  }
  return conditions;
}

export interface Audience {
  /** Distinct people who bought in range. A team buyer counts once. */
  buyers: number;
  /** Distinct people who enrolled in range, by purchase or by seat coupon. */
  students: number;
  /** Revenue attributed to those students' enrolments (see below). */
  studentRevenueCents: number;
  /** studentRevenueCents over students; 0 when there are no students. */
  revenuePerStudentCents: number;
}

/**
 * Revenue attributed to the enrolments in scope. An individual buyer brings
 * what they paid. A seat redeemer brings their share of the team purchase
 * that minted the coupon: its amount over its seat count. Without this walk,
 * students on team seats bring nothing and teams look worthless.
 */
function getStudentRevenue(scope: AnalyticsScope): number {
  const enrolled = db
    .selectDistinct({
      userId: enrollments.userId,
      courseId: enrollments.courseId,
    })
    .from(enrollments)
    .innerJoin(courses, eq(enrollments.courseId, courses.id))
    .where(and(...enrollmentConditions(scope)))
    .as("enrolled");

  const bought = alias(purchases, "bought");
  const boughtSeat = alias(coupons, "bought_seat");
  const seat = alias(coupons, "seat");
  const teamPurchase = alias(purchases, "team_purchase");
  const sibling = alias(coupons, "sibling");

  const individual = sql<number>`coalesce((
    select sum(${bought.amountPaid}) from ${purchases} ${bought}
    where ${bought.userId} = ${enrolled.userId}
      and ${bought.courseId} = ${enrolled.courseId}
      and not exists (
        select 1 from ${coupons} ${boughtSeat} where ${boughtSeat.purchaseId} = ${bought.id}
      )
  ), 0)`;

  const seatShare = sql<number>`coalesce((
    select sum(${teamPurchase.amountPaid} * 1.0 / (
      select count(*) from ${coupons} ${sibling} where ${sibling.purchaseId} = ${teamPurchase.id}
    ))
    from ${coupons} ${seat}
    inner join ${purchases} ${teamPurchase} on ${teamPurchase.id} = ${seat.purchaseId}
    where ${seat.redeemedByUserId} = ${enrolled.userId}
      and ${seat.courseId} = ${enrolled.courseId}
  ), 0)`;

  const row = db
    .select({
      total: sql<number>`coalesce(sum(${individual} + ${seatShare}), 0)`,
    })
    .from(enrolled)
    .get();

  return Math.round(row?.total ?? 0);
}

function getAudience(scope: AnalyticsScope): Audience {
  const buyers = db
    .select({ count: sql<number>`count(distinct ${purchases.userId})` })
    .from(purchases)
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(and(...purchaseConditions(scope)))
    .get();

  const students = db
    .select({ count: sql<number>`count(distinct ${enrollments.userId})` })
    .from(enrollments)
    .innerJoin(courses, eq(enrollments.courseId, courses.id))
    .where(and(...enrollmentConditions(scope)))
    .get();

  const studentCount = students?.count ?? 0;
  const studentRevenueCents = getStudentRevenue(scope);
  return {
    buyers: buyers?.count ?? 0,
    students: studentCount,
    studentRevenueCents,
    revenuePerStudentCents:
      studentCount === 0 ? 0 : Math.round(studentRevenueCents / studentCount),
  };
}

export interface TopBuyer {
  userId: number;
  name: string;
  email: string;
  /** Spend in range across every course in scope. */
  totalSpentCents: number;
  /** True when any of those purchases bought team seats. */
  isTeamBuyer: boolean;
  /** Seats bought through team purchases; 0 for individual buyers. */
  seats: number;
  /** Of those seats, the ones no one has redeemed. */
  unredeemedSeats: number;
  /** Enrolled in a course in scope. Buyers who never enrolled still rank. */
  enrolled: boolean;
}

const TOP_BUYER_LIMIT = 10;

function getTopBuyers(scope: AnalyticsScope): TopBuyer[] {
  const seat = alias(coupons, "seat");
  const enrolment = alias(enrollments, "enrolment");
  const enrolledCourse = alias(courses, "enrolled_course");

  const seatsExpr = sql<number>`coalesce(sum((
    select count(*) from ${coupons} ${seat} where ${seat.purchaseId} = ${purchases.id}
  )), 0)`;
  const unredeemedExpr = sql<number>`coalesce(sum((
    select count(*) from ${coupons} ${seat}
    where ${seat.purchaseId} = ${purchases.id} and ${seat.redeemedByUserId} is null
  )), 0)`;
  const instructorFilter =
    scope.instructorId === null
      ? sql``
      : sql`and ${enrolledCourse.instructorId} = ${scope.instructorId}`;
  const enrolledExpr = sql<number>`exists (
    select 1 from ${enrollments} ${enrolment}
    inner join ${courses} ${enrolledCourse} on ${enrolledCourse.id} = ${enrolment.courseId}
    where ${enrolment.userId} = ${purchases.userId} ${instructorFilter}
  )`;
  const totalExpr = sql<number>`sum(${purchases.amountPaid})`;

  const rows = db
    .select({
      userId: users.id,
      name: users.name,
      email: users.email,
      totalSpentCents: totalExpr,
      seats: seatsExpr,
      unredeemedSeats: unredeemedExpr,
      enrolled: enrolledExpr,
    })
    .from(purchases)
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .innerJoin(users, eq(purchases.userId, users.id))
    .where(and(...purchaseConditions(scope)))
    .groupBy(users.id)
    .orderBy(desc(totalExpr), asc(users.name))
    .limit(TOP_BUYER_LIMIT)
    .all();

  return rows.map((row) => ({
    userId: row.userId,
    name: row.name,
    email: row.email,
    totalSpentCents: row.totalSpentCents,
    isTeamBuyer: row.seats > 0,
    seats: row.seats,
    unredeemedSeats: row.unredeemedSeats,
    enrolled: Boolean(row.enrolled),
  }));
}

export interface SeatSummary {
  /** Team seats bought in range. */
  sold: number;
  /** Of those, the ones whose coupon was never redeemed. */
  unredeemed: number;
}

function getSeats(scope: AnalyticsScope): SeatSummary {
  const row = db
    .select({
      sold: sql<number>`count(*)`,
      unredeemed: sql<number>`coalesce(sum(case when ${coupons.redeemedByUserId} is null then 1 else 0 end), 0)`,
    })
    .from(coupons)
    .innerJoin(purchases, eq(coupons.purchaseId, purchases.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(and(...purchaseConditions(scope)))
    .get();

  return { sold: row?.sold ?? 0, unredeemed: row?.unredeemed ?? 0 };
}

/** Open questions on courses in scope, asked in range. */
function countUnansweredQuestions(scope: AnalyticsScope): number {
  const cutoff = resolveCutoff(scope);
  const questions = getUnansweredQuestions(scope.instructorId);
  if (cutoff === null) return questions.length;
  return questions.filter((question) => question.createdAt >= cutoff).length;
}

export interface CourseRatings {
  courseId: number;
  title: string;
  /** Rounded to 1dp; null when the course has no ratings in range. */
  average: number | null;
  count: number;
}

export interface RatingsSummary {
  /** Across every rating in range; null when there are none. */
  average: number | null;
  count: number;
  /** Every non-draft course in scope, by title, rated or not. */
  courses: CourseRatings[];
}

function roundRating(average: number): number {
  return Math.round(average * 10) / 10;
}

/**
 * Ratings given (or last changed) in range. A rating is a current opinion,
 * so its updatedAt is the date that counts.
 */
function getRatings(scope: AnalyticsScope): RatingsSummary {
  const cutoff = resolveCutoff(scope);
  const joinConditions: SQL[] = [eq(courseRatings.courseId, courses.id)];
  if (cutoff !== null) {
    joinConditions.push(gte(courseRatings.updatedAt, cutoff));
  }
  const courseConditions: SQL[] = [ne(courses.status, CourseStatus.Draft)];
  if (scope.instructorId !== null) {
    courseConditions.push(eq(courses.instructorId, scope.instructorId));
  }

  const rows = db
    .select({
      courseId: courses.id,
      title: courses.title,
      stars: sql<number>`coalesce(sum(${courseRatings.rating}), 0)`,
      count: sql<number>`count(${courseRatings.id})`,
    })
    .from(courses)
    .leftJoin(courseRatings, and(...joinConditions))
    .where(and(...courseConditions))
    .groupBy(courses.id)
    .orderBy(asc(courses.title))
    .all();

  let stars = 0;
  let count = 0;
  for (const row of rows) {
    stars += row.stars;
    count += row.count;
  }

  return {
    average: count === 0 ? null : roundRating(stars / count),
    count,
    courses: rows.map((row) => ({
      courseId: row.courseId,
      title: row.title,
      average: row.count === 0 ? null : roundRating(row.stars / row.count),
      count: row.count,
    })),
  };
}

/**
 * The cross-course roll-up for the Overview tab. Extend this with new panels.
 */
export function getOverview(scope: AnalyticsScope) {
  return {
    hasPublishedCourse: hasPublishedCourse(scope.instructorId),
    revenue: getRevenue(scope),
    revenueOverTime: getRevenueOverTime(scope),
    audience: getAudience(scope),
    topBuyers: getTopBuyers(scope),
    seats: getSeats(scope),
    unansweredQuestions: countUnansweredQuestions(scope),
    ratings: getRatings(scope),
  };
}

// ─── Course detail ───
// The deep dive on one course for the Course detail tab. Extend
// getCourseDetail with new panels.

export interface CourseDetailScope {
  courseId: number;
  range: AnalyticsRange;
  now?: Date;
}

/** The ids of the students enrolled in a course, as a subquery. */
function enrolledUserIds(courseId: number) {
  return db
    .select({ userId: enrollments.userId })
    .from(enrollments)
    .where(eq(enrollments.courseId, courseId));
}

/** The course's lessons in course order: module position, then lesson position. */
function getCourseLessons(courseId: number) {
  return db
    .select({
      id: lessons.id,
      title: lessons.title,
      moduleId: modules.id,
      moduleTitle: modules.title,
    })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .where(eq(modules.courseId, courseId))
    .orderBy(asc(modules.position), asc(lessons.position), asc(lessons.id))
    .all();
}

interface StudentProgress {
  completedCount: number;
  /** 1-based course-order position of the furthest lesson reached, or null. */
  furthestReached: number | null;
}

/**
 * One row per enrolled student with lesson progress in the course. A lesson
 * is reached when it is in progress or completed. Students with no progress
 * have no row.
 */
function getStudentProgress(courseId: number): StudentProgress[] {
  // Same order as getCourseLessons.
  const lessonOrder = db.$with("lesson_order").as(
    db
      .select({
        lessonId: sql<number>`${lessons.id}`.as("ordered_lesson_id"),
        ordinal:
          sql<number>`row_number() over (order by ${modules.position}, ${lessons.position}, ${lessons.id})`.as(
            "ordinal"
          ),
      })
      .from(lessons)
      .innerJoin(modules, eq(lessons.moduleId, modules.id))
      .where(eq(modules.courseId, courseId))
  );

  return db
    .with(lessonOrder)
    .select({
      completedCount: sql<number>`count(distinct case when ${lessonProgress.status} = ${LessonProgressStatus.Completed} then ${lessonProgress.lessonId} end)`,
      furthestReached: sql<
        number | null
      >`max(case when ${lessonProgress.status} in (${LessonProgressStatus.InProgress}, ${LessonProgressStatus.Completed}) then ${lessonOrder.ordinal} end)`,
    })
    .from(lessonProgress)
    .innerJoin(lessonOrder, eq(lessonProgress.lessonId, lessonOrder.lessonId))
    .where(inArray(lessonProgress.userId, enrolledUserIds(courseId)))
    .groupBy(lessonProgress.userId)
    .all();
}

function countEnrolled(courseId: number): number {
  const row = db
    .select({ n: sql<number>`count(distinct ${enrollments.userId})` })
    .from(enrollments)
    .where(eq(enrollments.courseId, courseId))
    .get();
  return row?.n ?? 0;
}

/**
 * Progress is completed lessons over total lessons, not weighted by duration.
 * A finisher completed every lesson; enrollments.completedAt is rarely set, so
 * it is not used.
 */
function summariseProgress(
  students: StudentProgress[],
  enrolledCount: number,
  totalLessons: number
) {
  if (enrolledCount === 0 || totalLessons === 0) {
    return { enrolledCount, averageProgressPercent: 0, finishedCount: 0 };
  }
  const progressSum = students.reduce(
    (sum, student) => sum + student.completedCount / totalLessons,
    0
  );
  return {
    enrolledCount,
    averageProgressPercent: Math.round((progressSum / enrolledCount) * 100),
    finishedCount: students.filter(
      (student) => student.completedCount === totalLessons
    ).length,
  };
}

export interface FunnelLesson {
  id: number;
  title: string;
  /** Enrolled students who reached this lesson or a later one. */
  reachedCount: number;
  /**
   * Students lost on the way to this lesson: the previous lesson's count
   * minus this one's. For the first lesson, enrolled students who never
   * started.
   */
  dropCount: number;
}

export interface FunnelModule {
  id: number;
  title: string;
  /** Enrolled students who reached the module's first lesson or later. */
  reachedCount: number;
  /** Students lost on the way to and inside the module: its lessons' drops. */
  dropCount: number;
  lessons: FunnelLesson[];
}

export interface Funnel {
  /** The denominator: every bar is a part of this. */
  enrolledCount: number;
  modules: FunnelModule[];
}

/**
 * The drop-off funnel. Each lesson counts the students who reached at least
 * that lesson, so a skipped lesson is not a drop and the series only descends.
 */
function buildFunnel(
  courseLessons: ReturnType<typeof getCourseLessons>,
  students: StudentProgress[],
  enrolledCount: number
): Funnel {
  const reachedAtLeast = (position: number) =>
    students.filter((student) => (student.furthestReached ?? 0) >= position)
      .length;

  const modulesById = new Map<number, FunnelModule>();
  let previousCount = enrolledCount;
  courseLessons.forEach((lesson, index) => {
    const reachedCount = reachedAtLeast(index + 1);
    const dropCount = previousCount - reachedCount;
    previousCount = reachedCount;

    let mod = modulesById.get(lesson.moduleId);
    if (!mod) {
      mod = {
        id: lesson.moduleId,
        title: lesson.moduleTitle,
        reachedCount,
        dropCount: 0,
        lessons: [],
      };
      modulesById.set(lesson.moduleId, mod);
    }
    mod.dropCount += dropCount;
    mod.lessons.push({
      id: lesson.id,
      title: lesson.title,
      reachedCount,
      dropCount,
    });
  });

  return { enrolledCount, modules: [...modulesById.values()] };
}

/**
 * The deep dive on one course. Progress and the funnel come from lesson
 * progress, which has no start timestamp, so they are all time: the range
 * does not apply to them.
 */
export function getCourseDetail(scope: CourseDetailScope) {
  const courseLessons = getCourseLessons(scope.courseId);
  const enrolledCount = countEnrolled(scope.courseId);
  const students = getStudentProgress(scope.courseId);

  return {
    progress: summariseProgress(students, enrolledCount, courseLessons.length),
    funnel: buildFunnel(courseLessons, students, enrolledCount),
  };
}
