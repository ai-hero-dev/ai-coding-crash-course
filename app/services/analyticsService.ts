import { and, count, eq, gte, sql, sum } from "drizzle-orm";
import { db } from "~/db";
import { CourseStatus, courses, purchases, users } from "~/db/schema";
import { splitRevenue, type AnalyticsRange } from "~/lib/analytics";

// ─── Analytics Service ───
// Every figure on the instructor analytics page. Aggregates are grouped queries
// rather than loops over per-student helpers — an instructor with a real
// audience has thousands of purchase rows.
//
// Revenue is attributed to an instructor through the course they own. Pass null
// as the instructorId to span every instructor (the admin's platform-wide
// view), matching commentService.getUnansweredQuestions.
//
// Amounts are integer cents throughout, in a single implicit currency.
// Uses positional parameters (project convention).

export type RevenueSummary = {
  grossCents: number;
  feeCents: number;
  netCents: number;
  purchaseCount: number;
};

/** One column of the revenue chart. `bucket` is `YYYY-MM-DD` or `YYYY-MM`. */
export type RevenuePoint = {
  bucket: string;
  grossCents: number;
  netCents: number;
};

export type RevenueSeries = {
  granularity: "day" | "month";
  points: RevenuePoint[];
};

const RANGE_DAYS: Record<Exclude<AnalyticsRange, "all">, number> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
};

/**
 * The inclusive start of a range, as an ISO timestamp, or null for all time.
 *
 * The service resolves the range itself rather than taking a cutoff date, so
 * the boundary is decided in exactly one tested place. A purchase landing
 * exactly on the cutoff is inside the range.
 */
function rangeStart(range: AnalyticsRange): string | null {
  if (range === "all") return null;
  return new Date(Date.now() - RANGE_DAYS[range] * 86_400_000).toISOString();
}

function scope(instructorId: number | null, range: AnalyticsRange) {
  const conditions = [];

  if (instructorId !== null) {
    conditions.push(eq(courses.instructorId, instructorId));
  }

  const start = rangeStart(range);
  if (start !== null) {
    conditions.push(gte(purchases.createdAt, start));
  }

  return conditions.length > 0 ? and(...conditions) : undefined;
}

/**
 * Gross revenue, the platform's fee and the instructor's net for a range.
 *
 * The split happens here, not in the component: no revenue arithmetic should
 * live in code a test can't reach.
 */
export function getRevenueSummary(
  instructorId: number | null,
  range: AnalyticsRange
): RevenueSummary {
  const row = db
    .select({
      gross: sum(purchases.amountPaid),
      purchaseCount: count(purchases.id),
    })
    .from(purchases)
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(scope(instructorId, range))
    .get();

  // sum() returns null over an empty set, and a string when SQLite has rows.
  const grossCents = Number(row?.gross ?? 0);

  return {
    ...splitRevenue(grossCents),
    purchaseCount: row?.purchaseCount ?? 0,
  };
}

export type CourseRevenue = RevenueSummary & {
  courseId: number;
  title: string;
};

/**
 * Revenue broken down by course, biggest earner first.
 *
 * Courses with no sales in the range are absent rather than listed at zero.
 */
export function getRevenueByCourse(
  instructorId: number | null,
  range: AnalyticsRange
): CourseRevenue[] {
  const rows = db
    .select({
      courseId: courses.id,
      title: courses.title,
      gross: sum(purchases.amountPaid),
      purchaseCount: count(purchases.id),
    })
    .from(purchases)
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(scope(instructorId, range))
    .groupBy(courses.id)
    .all();

  return rows
    .map((row) => ({
      courseId: row.courseId,
      title: row.title,
      ...splitRevenue(Number(row.gross ?? 0)),
      purchaseCount: row.purchaseCount,
    }))
    .sort((a, b) => b.grossCents - a.grossCents);
}

/**
 * Everyone who owns at least one course, for the admin's instructor picker.
 *
 * Owners rather than users with the instructor role: an admin who owns a
 * course contributes to the platform-wide total, so leaving them unpickable
 * would leave a slice of revenue nobody could drill into.
 */
export function listCourseOwners(): { id: number; name: string }[] {
  return db
    .selectDistinct({ id: users.id, name: users.name })
    .from(courses)
    .innerJoin(users, eq(courses.instructorId, users.id))
    .orderBy(users.name)
    .all();
}

/**
 * Has this instructor published anything yet?
 *
 * Drives the "publish your first course" empty state — a newcomer should be
 * told what to do next, not shown a dashboard of zeroes.
 */
export function hasPublishedCourses(instructorId: number): boolean {
  const row = db
    .select({ id: courses.id })
    .from(courses)
    .where(
      and(
        eq(courses.instructorId, instructorId),
        eq(courses.status, CourseStatus.Published)
      )
    )
    .get();

  return row !== undefined;
}

/** The bucket an ISO timestamp falls in, at the given granularity. */
function bucketOf(iso: string, granularity: "day" | "month"): string {
  return iso.slice(0, granularity === "day" ? 10 : 7);
}

/** Every bucket from `first` to `last` inclusive, with none skipped. */
function bucketRange(
  first: string,
  last: string,
  granularity: "day" | "month"
): string[] {
  const buckets: string[] = [];
  const cursor = new Date(
    `${first}${granularity === "day" ? "" : "-01"}T00:00:00.000Z`
  );

  while (bucketOf(cursor.toISOString(), granularity) <= last) {
    buckets.push(bucketOf(cursor.toISOString(), granularity));
    if (granularity === "day") {
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    } else {
      cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    }
  }

  return buckets;
}

/**
 * Revenue over time for the chart, oldest bucket first.
 *
 * Day buckets for the fixed ranges; all time would be a year of unreadable
 * daily columns, so it groups by month instead. Quiet buckets are emitted as
 * zeroes rather than skipped — a chart that omits them draws a flat line
 * between two distant dates and reads as steady income.
 */
export function getRevenueOverTime(
  instructorId: number | null,
  range: AnalyticsRange
): RevenueSeries {
  const granularity = range === "all" ? "month" : "day";
  const bucketExpr = sql<string>`substr(${purchases.createdAt}, 1, ${
    granularity === "day" ? 10 : 7
  })`;

  const rows = db
    .select({ bucket: bucketExpr, gross: sum(purchases.amountPaid) })
    .from(purchases)
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(scope(instructorId, range))
    .groupBy(bucketExpr)
    .orderBy(bucketExpr)
    .all();

  if (rows.length === 0 && range === "all") return { granularity, points: [] };

  const grossByBucket = new Map(
    rows.map((row) => [row.bucket, Number(row.gross ?? 0)])
  );

  const now = new Date().toISOString();
  // A fixed range always spans its whole window, even before the first sale;
  // all time can only start where the data does.
  const start = rangeStart(range) ?? rows[0].bucket;

  const points = bucketRange(
    bucketOf(start, granularity),
    bucketOf(now, granularity),
    granularity
  ).map((bucket) => {
    const { grossCents, netCents } = splitRevenue(
      grossByBucket.get(bucket) ?? 0
    );
    return { bucket, grossCents, netCents };
  });

  return { granularity, points };
}
