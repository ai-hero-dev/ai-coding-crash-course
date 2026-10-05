import { and, asc, desc, eq, gte, ne, sql, type SQL } from "drizzle-orm";
import { db } from "~/db";
import { alias } from "drizzle-orm/sqlite-core";
import {
  CourseStatus,
  coupons,
  courseRatings,
  courses,
  enrollments,
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
