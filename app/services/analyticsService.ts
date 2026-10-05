import { and, asc, eq, gte, sql, type SQL } from "drizzle-orm";
import { db } from "~/db";
import { CourseStatus, courses, purchases } from "~/db/schema";
import { PLATFORM_FEE_RATE, type AnalyticsRange } from "~/lib/analytics";

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

/**
 * The cross-course roll-up for the Overview tab. Extend this with new panels.
 */
export function getOverview(scope: AnalyticsScope) {
  return {
    hasPublishedCourse: hasPublishedCourse(scope.instructorId),
    revenue: getRevenue(scope),
    revenueOverTime: getRevenueOverTime(scope),
  };
}
