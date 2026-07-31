import {
  and,
  count,
  countDistinct,
  desc,
  eq,
  gte,
  inArray,
  notExists,
  sql,
  sum,
} from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { db } from "~/db";
import {
  CourseStatus,
  courseRatings,
  courses,
  coupons,
  enrollments,
  purchases,
  users,
} from "~/db/schema";
import { rangeStart, splitRevenue, type AnalyticsRange } from "~/lib/analytics";

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

/**
 * The instructor filter and the range, as one where-clause.
 *
 * Which column carries the date depends on what is being counted — a purchase
 * happens when it is paid for, an enrolment when the seat is claimed — so the
 * caller names it.
 */
function scopeOn(
  dateColumn: SQLiteColumn,
  instructorId: number | null,
  range: AnalyticsRange
) {
  const conditions = [];

  if (instructorId !== null) {
    conditions.push(eq(courses.instructorId, instructorId));
  }

  const start = rangeStart(range);
  if (start !== null) {
    conditions.push(gte(dateColumn, start));
  }

  return conditions.length > 0 ? and(...conditions) : undefined;
}

/** The common case: figures counted from when the money changed hands. */
function purchaseScope(instructorId: number | null, range: AnalyticsRange) {
  return scopeOn(purchases.createdAt, instructorId, range);
}

/** The instructor filter on its own, for figures no range applies to. */
function ownedBy(instructorId: number | null) {
  return instructorId === null
    ? undefined
    : eq(courses.instructorId, instructorId);
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
    .where(purchaseScope(instructorId, range))
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
    .where(purchaseScope(instructorId, range))
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

export type StudentRevenue = {
  userId: number;
  name: string;
  revenueCents: number;
};

/**
 * Revenue attributed to each enrolled student, by name.
 *
 * A seat claimed with a coupon is walked back to the team purchase that minted
 * it and credited with that purchase's share of one seat. Without the walk
 * every team student looks free, and an instructor who sells to teams sees
 * their revenue per student collapse.
 *
 * A purchase that minted coupons is never credited to its buyer directly:
 * the seats it bought carry it, so nothing is counted twice. Seats nobody
 * claimed are attributed to nobody at all.
 *
 * The range picks the students — who enrolled in this period — and not the
 * money: what was paid for a seat is what was paid for it, whenever that was.
 */
export function getStudentRevenue(
  instructorId: number | null,
  range: AnalyticsRange
): StudentRevenue[] {
  const students = db
    .selectDistinct({ userId: users.id, name: users.name })
    .from(enrollments)
    .innerJoin(courses, eq(enrollments.courseId, courses.id))
    .innerJoin(users, eq(users.id, enrollments.userId))
    .where(scopeOn(enrollments.enrolledAt, instructorId, range))
    .orderBy(users.name)
    .all();

  if (students.length === 0) return [];

  const studentIds = students.map((student) => student.userId);

  // Correlated: did this purchase mint seats for other people?
  const mintedSeats = db
    .select({ one: sql`1` })
    .from(coupons)
    .where(eq(coupons.purchaseId, purchases.id));

  const direct = db
    .select({ userId: purchases.userId, paid: sum(purchases.amountPaid) })
    .from(purchases)
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(
      and(
        inArray(purchases.userId, studentIds),
        notExists(mintedSeats),
        ownedBy(instructorId)
      )
    )
    .groupBy(purchases.userId)
    .all();

  const seatCounts = db
    .select({ purchaseId: coupons.purchaseId, seats: count().as("seats") })
    .from(coupons)
    .groupBy(coupons.purchaseId)
    .as("seat_counts");

  const viaSeat = db
    .select({
      userId: coupons.redeemedByUserId,
      // Divided rather than rounded per row: the shares are summed first and
      // rounded once, so five seats out of 3333 cents still add up.
      paid: sql<number>`sum(${purchases.amountPaid} * 1.0 / ${seatCounts.seats})`,
    })
    .from(coupons)
    .innerJoin(purchases, eq(coupons.purchaseId, purchases.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .innerJoin(seatCounts, eq(seatCounts.purchaseId, coupons.purchaseId))
    .where(
      and(inArray(coupons.redeemedByUserId, studentIds), ownedBy(instructorId))
    )
    .groupBy(coupons.redeemedByUserId)
    .all();

  const paidByUser = new Map<number, number>();
  const credit = (userId: number | null, paid: unknown) => {
    if (userId === null) return;
    paidByUser.set(userId, (paidByUser.get(userId) ?? 0) + Number(paid ?? 0));
  };

  for (const row of direct) credit(row.userId, row.paid);
  for (const row of viaSeat) credit(row.userId, row.paid);

  return students.map((student) => ({
    ...student,
    revenueCents: Math.round(paidByUser.get(student.userId) ?? 0),
  }));
}

export type AudienceSummary = {
  buyerCount: number;
  studentCount: number;
  /** Null rather than zero when there are no students to divide by. */
  revenuePerStudentCents: number | null;
};

/**
 * How many people paid, and how many are learning.
 *
 * Deliberately two numbers: one team purchase is a single buyer covering
 * several seats, and someone who redeems a seat enrols without a purchase row
 * of their own. Conflating them flatters one figure and starves the other.
 */
export function getAudienceSummary(
  instructorId: number | null,
  range: AnalyticsRange
): AudienceSummary {
  const buyers = db
    .select({ buyerCount: countDistinct(purchases.userId) })
    .from(purchases)
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(purchaseScope(instructorId, range))
    .get();

  const students = getStudentRevenue(instructorId, range);
  const attributed = students.reduce(
    (total, student) => total + student.revenueCents,
    0
  );

  return {
    buyerCount: buyers?.buyerCount ?? 0,
    studentCount: students.length,
    revenuePerStudentCents:
      students.length === 0 ? null : Math.round(attributed / students.length),
  };
}

/** How many buyers the leaderboard holds. */
const TOP_BUYER_LIMIT = 10;

export type TopBuyer = {
  userId: number;
  name: string;
  email: string;
  spendCents: number;
  purchaseCount: number;
  /** Seats bought for other people; zero for someone buying for themselves. */
  seatsBought: number;
  seatsUnredeemed: number;
  enrolled: boolean;
};

/**
 * The biggest spenders across the instructor's courses, richest first.
 *
 * Built from purchases rather than enrolments, so the purchasing manager who
 * bought a dozen seats and never opened the course still appears — they are
 * exactly who is worth a conversation.
 */
export function getTopBuyers(
  instructorId: number | null,
  range: AnalyticsRange
): TopBuyer[] {
  const buyers = db
    .select({
      userId: users.id,
      name: users.name,
      email: users.email,
      spend: sum(purchases.amountPaid),
      purchaseCount: count(purchases.id),
    })
    .from(purchases)
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .innerJoin(users, eq(users.id, purchases.userId))
    .where(purchaseScope(instructorId, range))
    .groupBy(users.id)
    .orderBy(desc(sum(purchases.amountPaid)))
    .limit(TOP_BUYER_LIMIT)
    .all();

  if (buyers.length === 0) return [];

  const buyerIds = buyers.map((buyer) => buyer.userId);

  // Seats are counted in their own query: joining coupons to purchases above
  // would repeat each purchase once per seat and multiply the spend the
  // leaderboard ranks on.
  const seats = db
    .select({
      userId: purchases.userId,
      bought: count(coupons.id),
      unredeemed: sql<number>`sum(case when ${coupons.redeemedByUserId} is null then 1 else 0 end)`,
    })
    .from(coupons)
    .innerJoin(purchases, eq(coupons.purchaseId, purchases.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(
      and(
        inArray(purchases.userId, buyerIds),
        purchaseScope(instructorId, range)
      )
    )
    .groupBy(purchases.userId)
    .all();

  const seatsByUser = new Map(seats.map((row) => [row.userId, row]));

  // No range here: "never enrolled" is a fact about the person, not about the
  // last thirty days.
  const enrolled = new Set(
    db
      .selectDistinct({ userId: enrollments.userId })
      .from(enrollments)
      .innerJoin(courses, eq(enrollments.courseId, courses.id))
      .where(and(inArray(enrollments.userId, buyerIds), ownedBy(instructorId)))
      .all()
      .map((row) => row.userId)
  );

  return buyers.map((buyer) => ({
    userId: buyer.userId,
    name: buyer.name,
    email: buyer.email,
    spendCents: Number(buyer.spend ?? 0),
    purchaseCount: buyer.purchaseCount,
    seatsBought: seatsByUser.get(buyer.userId)?.bought ?? 0,
    seatsUnredeemed: Number(seatsByUser.get(buyer.userId)?.unredeemed ?? 0),
    enrolled: enrolled.has(buyer.userId),
  }));
}

export type RatingSummary = {
  average: number | null;
  count: number;
};

/**
 * How the instructor's courses are rated, averaged over every rating rather
 * than over per-course averages — a course with one five-star rating shouldn't
 * outweigh one with two hundred.
 */
export function getRatingSummary(
  instructorId: number | null,
  range: AnalyticsRange
): RatingSummary {
  const row = db
    .select({
      average: sql<number | null>`avg(${courseRatings.rating})`,
      count: count(courseRatings.id),
    })
    .from(courseRatings)
    .innerJoin(courses, eq(courseRatings.courseId, courses.id))
    .where(scopeOn(courseRatings.createdAt, instructorId, range))
    .get();

  if (!row || row.count === 0 || row.average === null) {
    return { average: null, count: 0 };
  }

  return { average: Math.round(row.average * 10) / 10, count: row.count };
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
    .where(purchaseScope(instructorId, range))
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
