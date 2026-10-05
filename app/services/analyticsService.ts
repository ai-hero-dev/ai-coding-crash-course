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
import { alias, type SQLiteColumn } from "drizzle-orm/sqlite-core";
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
  quizAttempts,
  quizzes,
  users,
} from "~/db/schema";
import { PLATFORM_FEE_RATE, type AnalyticsRange } from "~/lib/analytics";
import { PPP_TIERS, getCountryTierInfo } from "~/lib/ppp";
import { getUnansweredQuestions } from "~/services/commentService";

// ─── Analytics Service ───
// Read-only roll-ups for the instructor analytics page.
// Uses positional parameters (project convention).

export type { AnalyticsRange };

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
function resolveCutoff(range: AnalyticsRange, now: Date): string | null {
  const days = RANGE_DAYS[range];
  if (days === null) return null;
  return addUtcDays(now, -days).toISOString();
}

/** UTC days have no DST shifts, so this moves by exactly 24h per day. */
function addUtcDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

/**
 * The instructor filter and the range cutoff as one condition. A null
 * instructorId (platform-wide) or a null cutoff (all time) drops that part;
 * with neither, the result is undefined, which Drizzle reads as no filter.
 * The instructor part needs `courses` in the query.
 */
function scopeFilter(
  instructorId: number | null,
  dateColumn?: SQLiteColumn,
  cutoff: string | null = null
): SQL | undefined {
  return and(
    instructorId === null ? undefined : eq(courses.instructorId, instructorId),
    dateColumn === undefined || cutoff === null
      ? undefined
      : gte(dateColumn, cutoff)
  );
}

/** Course order: module position, then lesson position, then id for ties. */
const LESSON_ORDER: SQL[] = [
  asc(modules.position),
  asc(lessons.position),
  asc(lessons.id),
];

function getRevenue(instructorId: number | null, cutoff: string | null) {
  const row = db
    .select({
      gross: sql<number>`coalesce(sum(${purchases.amountPaid}), 0)`,
    })
    .from(purchases)
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(scopeFilter(instructorId, purchases.createdAt, cutoff))
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
    return addUtcDays(date, 1).toISOString().slice(0, 10);
  }
  const [year, month] = period.split("-").map(Number);
  return new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 7);
}

/**
 * Gross revenue per period, with a zero for each period without sales, from
 * the range start (or the first sale, for all time) up to now.
 */
function getRevenueOverTime(
  instructorId: number | null,
  range: AnalyticsRange,
  now: Date
): RevenuePoint[] {
  const granularity: Granularity = range === "all" ? "month" : "day";
  const cutoff = resolveCutoff(range, now);
  const length = PERIOD_LENGTH[granularity];
  const periodExpr = sql<string>`substr(${purchases.createdAt}, 1, ${length})`;

  const rows = db
    .select({
      period: periodExpr,
      gross: sql<number>`sum(${purchases.amountPaid})`,
    })
    .from(purchases)
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(scopeFilter(instructorId, purchases.createdAt, cutoff))
    .groupBy(periodExpr)
    .orderBy(periodExpr)
    .all();

  const first = cutoff?.slice(0, length) ?? rows[0]?.period;
  if (first === undefined) return [];

  const last = now.toISOString().slice(0, length);
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
    .where(scopeFilter(instructorId))
    .orderBy(asc(courses.title))
    .all();
}

function hasPublishedCourse(instructorId: number | null): boolean {
  const row = db
    .select({ id: courses.id })
    .from(courses)
    .where(
      and(eq(courses.status, CourseStatus.Published), scopeFilter(instructorId))
    )
    .limit(1)
    .get();
  return row !== undefined;
}

// ─── Overview: buyers, students, leaderboard, questions, ratings ───

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
function getStudentRevenue(
  instructorId: number | null,
  cutoff: string | null
): number {
  const enrolled = db
    .selectDistinct({
      userId: enrollments.userId,
      courseId: enrollments.courseId,
    })
    .from(enrollments)
    .innerJoin(courses, eq(enrollments.courseId, courses.id))
    .where(scopeFilter(instructorId, enrollments.enrolledAt, cutoff))
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

function getAudience(
  instructorId: number | null,
  cutoff: string | null
): Audience {
  const buyers = db
    .select({ count: sql<number>`count(distinct ${purchases.userId})` })
    .from(purchases)
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(scopeFilter(instructorId, purchases.createdAt, cutoff))
    .get();

  const students = db
    .select({ count: sql<number>`count(distinct ${enrollments.userId})` })
    .from(enrollments)
    .innerJoin(courses, eq(enrollments.courseId, courses.id))
    .where(scopeFilter(instructorId, enrollments.enrolledAt, cutoff))
    .get();

  const studentCount = students?.count ?? 0;
  const studentRevenueCents = getStudentRevenue(instructorId, cutoff);
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

function getTopBuyers(
  instructorId: number | null,
  cutoff: string | null
): TopBuyer[] {
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
    instructorId === null
      ? sql``
      : sql`and ${enrolledCourse.instructorId} = ${instructorId}`;
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
    .where(scopeFilter(instructorId, purchases.createdAt, cutoff))
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

function getSeats(
  instructorId: number | null,
  cutoff: string | null
): SeatSummary {
  const row = db
    .select({
      sold: sql<number>`count(*)`,
      unredeemed: sql<number>`coalesce(sum(case when ${coupons.redeemedByUserId} is null then 1 else 0 end), 0)`,
    })
    .from(coupons)
    .innerJoin(purchases, eq(coupons.purchaseId, purchases.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(scopeFilter(instructorId, purchases.createdAt, cutoff))
    .get();

  return { sold: row?.sold ?? 0, unredeemed: row?.unredeemed ?? 0 };
}

/**
 * Open questions on courses in scope, over all time. A question still waits
 * however old it is, so the range does not apply.
 */
function countUnansweredQuestions(instructorId: number | null): number {
  return getUnansweredQuestions(instructorId).length;
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
function getRatings(
  instructorId: number | null,
  cutoff: string | null
): RatingsSummary {
  const rows = db
    .select({
      courseId: courses.id,
      title: courses.title,
      stars: sql<number>`coalesce(sum(${courseRatings.rating}), 0)`,
      count: sql<number>`count(${courseRatings.id})`,
    })
    .from(courses)
    .leftJoin(
      courseRatings,
      and(
        eq(courseRatings.courseId, courses.id),
        scopeFilter(null, courseRatings.updatedAt, cutoff)
      )
    )
    .where(
      and(ne(courses.status, CourseStatus.Draft), scopeFilter(instructorId))
    )
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
 * Pass null as instructorId for the whole platform (admins). `now` is for
 * tests. Unanswered questions are all time: the range does not apply.
 */
export function getOverview(
  instructorId: number | null,
  range: AnalyticsRange,
  now: Date = new Date()
) {
  const cutoff = resolveCutoff(range, now);
  return {
    hasPublishedCourse: hasPublishedCourse(instructorId),
    revenue: getRevenue(instructorId, cutoff),
    revenueOverTime: getRevenueOverTime(instructorId, range, now),
    audience: getAudience(instructorId, cutoff),
    topBuyers: getTopBuyers(instructorId, cutoff),
    seats: getSeats(instructorId, cutoff),
    unansweredQuestions: countUnansweredQuestions(instructorId),
    ratings: getRatings(instructorId, cutoff),
  };
}

export type Overview = ReturnType<typeof getOverview>;

// ─── Course detail ───
// The deep dive on one course for the Course detail tab. Extend
// getCourseDetail with new panels.

/** The ids of the students enrolled in a course, as a subquery. */
function enrolledUserIds(courseId: number) {
  return db
    .select({ userId: enrollments.userId })
    .from(enrollments)
    .where(eq(enrollments.courseId, courseId));
}

/** The course's lessons in course order (LESSON_ORDER). */
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
    .orderBy(...LESSON_ORDER)
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
  const lessonOrder = db.$with("lesson_order").as(
    db
      .select({
        lessonId: sql<number>`${lessons.id}`.as("ordered_lesson_id"),
        ordinal:
          sql<number>`row_number() over (order by ${sql.join(LESSON_ORDER, sql`, `)})`.as(
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
    .select({ count: sql<number>`count(distinct ${enrollments.userId})` })
    .from(enrollments)
    .where(eq(enrollments.courseId, courseId))
    .get();
  return row?.count ?? 0;
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

    let funnelModule = modulesById.get(lesson.moduleId);
    if (!funnelModule) {
      funnelModule = {
        id: lesson.moduleId,
        title: lesson.moduleTitle,
        reachedCount,
        dropCount: 0,
        lessons: [],
      };
      modulesById.set(lesson.moduleId, funnelModule);
    }
    funnelModule.dropCount += dropCount;
    funnelModule.lessons.push({
      id: lesson.id,
      title: lesson.title,
      reachedCount,
      dropCount,
    });
  });

  return { enrolledCount, modules: [...modulesById.values()] };
}

export interface QuizPassRate {
  quizId: number;
  title: string;
  lessonTitle: string;
  /** Distinct students with at least one attempt in range. */
  studentCount: number;
  /** Of those, the students whose best attempt passed. */
  passedCount: number;
  /** passedCount over studentCount; null when no one attempted the quiz. */
  passRatePercent: number | null;
}

/**
 * One result per student per quiz: their best attempt in range, the highest
 * score (a passed attempt wins a tie), judged by its stored passed flag. This
 * matches the student roster. A quiz with no attempts still has a row.
 */
function getQuizPassRates(
  courseId: number,
  cutoff: string | null
): QuizPassRate[] {
  const ranked = db.$with("ranked_attempt").as(
    db
      .select({
        quizId: sql<number>`${quizAttempts.quizId}`.as("ranked_quiz_id"),
        passed: sql<number>`${quizAttempts.passed}`.as("ranked_passed"),
        rank: sql<number>`row_number() over (partition by ${quizAttempts.userId}, ${quizAttempts.quizId} order by ${quizAttempts.score} desc, ${quizAttempts.passed} desc)`.as(
          "attempt_rank"
        ),
      })
      .from(quizAttempts)
      .where(scopeFilter(null, quizAttempts.attemptedAt, cutoff))
  );

  const rows = db
    .with(ranked)
    .select({
      quizId: quizzes.id,
      title: quizzes.title,
      lessonTitle: lessons.title,
      studentCount: sql<number>`count(${ranked.quizId})`,
      passedCount: sql<number>`coalesce(sum(${ranked.passed}), 0)`,
    })
    .from(quizzes)
    .innerJoin(lessons, eq(quizzes.lessonId, lessons.id))
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .leftJoin(ranked, and(eq(ranked.quizId, quizzes.id), eq(ranked.rank, 1)))
    .where(eq(modules.courseId, courseId))
    .groupBy(quizzes.id)
    .orderBy(...LESSON_ORDER, asc(quizzes.id))
    .all();

  return rows.map((row) => ({
    ...row,
    passRatePercent:
      row.studentCount === 0
        ? null
        : Math.round((row.passedCount / row.studentCount) * 100),
  }));
}

export interface CountryRevenue {
  /** ISO-2 code as recorded on the purchase; null when none was recorded. */
  country: string | null;
  purchaseCount: number;
  revenueCents: number;
  /**
   * The country's CURRENT PPP tier label, or null for no country. The
   * discount a purchase got is not stored, so this is not reconstructed.
   * When the course has PPP turned off, every country is full price.
   */
  discountLabel: string | null;
  /** The course has PPP on and the country's current tier gives a discount. */
  discounted: boolean;
}

export interface CountryRevenueSummary {
  totalCents: number;
  /** Revenue from countries marked discounted. 0 when PPP is off. */
  discountedCents: number;
  purchaseCount: number;
  /** By revenue, highest first. */
  countries: CountryRevenue[];
}

/** The course's purchases in range, grouped by buyer country. */
function getCountryRevenue(
  courseId: number,
  cutoff: string | null
): CountryRevenueSummary {
  const revenueExpr = sql<number>`sum(${purchases.amountPaid})`;
  const rows = db
    .select({
      country: purchases.country,
      purchaseCount: sql<number>`count(*)`,
      revenueCents: revenueExpr,
    })
    .from(purchases)
    .where(
      and(
        eq(purchases.courseId, courseId),
        scopeFilter(null, purchases.createdAt, cutoff)
      )
    )
    .groupBy(purchases.country)
    .orderBy(desc(revenueExpr), asc(purchases.country))
    .all();

  // With PPP off, every buyer paid full price, whatever their country's tier.
  const course = db
    .select({ pppEnabled: courses.pppEnabled })
    .from(courses)
    .where(eq(courses.id, courseId))
    .get();
  const pppEnabled = course?.pppEnabled ?? false;

  const countries = rows.map((row): CountryRevenue => {
    if (row.country === null) {
      return { ...row, discountLabel: null, discounted: false };
    }
    if (!pppEnabled) {
      return { ...row, discountLabel: PPP_TIERS[1].label, discounted: false };
    }
    const { tier, label } = getCountryTierInfo(row.country);
    return { ...row, discountLabel: label, discounted: tier > 1 };
  });

  const sum = (list: CountryRevenue[]) =>
    list.reduce((total, row) => total + row.revenueCents, 0);
  return {
    totalCents: sum(countries),
    discountedCents: sum(countries.filter((row) => row.discounted)),
    purchaseCount: countries.reduce(
      (total, row) => total + row.purchaseCount,
      0
    ),
    countries,
  };
}

/**
 * The deep dive on one course. Progress and the funnel come from lesson
 * progress, which has no start timestamp, so they are all time: the range
 * does not apply to them. Quiz pass rates and country revenue use the range.
 */
export function getCourseDetail(
  courseId: number,
  range: AnalyticsRange,
  now: Date = new Date()
) {
  const cutoff = resolveCutoff(range, now);
  const courseLessons = getCourseLessons(courseId);
  const enrolledCount = countEnrolled(courseId);
  const students = getStudentProgress(courseId);

  return {
    progress: summariseProgress(students, enrolledCount, courseLessons.length),
    funnel: buildFunnel(courseLessons, students, enrolledCount),
    quizPassRates: getQuizPassRates(courseId, cutoff),
    countryRevenue: getCountryRevenue(courseId, cutoff),
  };
}

export type CourseDetail = ReturnType<typeof getCourseDetail>;
