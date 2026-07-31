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
  LessonProgressStatus,
  courseRatings,
  courses,
  coupons,
  enrollments,
  lessonProgress,
  lessons,
  modules,
  purchases,
  quizAttempts,
  quizzes,
  users,
} from "~/db/schema";
import { rangeStart, splitRevenue, type AnalyticsRange } from "~/lib/analytics";
import { getDiscountForCountry } from "~/lib/ppp";

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

/**
 * The range on its own, for figures already narrowed to one course.
 *
 * The course-detail panels are scoped by the course they were given rather
 * than by who owns it, so they need the range without the instructor join.
 */
function since(dateColumn: SQLiteColumn, range: AnalyticsRange) {
  const start = rangeStart(range);
  return start === null ? undefined : gte(dateColumn, start);
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

// ─── Course detail ───
// Everything below answers "is anybody finishing this course, and if not,
// where do they stop". These figures carry no date filter: a lesson progress
// row is only timestamped once it is completed, and never timestamped at all
// while it is in progress, so an in-progress lesson cannot be put in a bucket.
// The page labels them "all time" rather than filtering them by a range they
// cannot honour.

/** Every lesson of a course, as a subquery for the progress joins. */
function courseLessonIds(courseId: number) {
  return db
    .select({ id: lessons.id })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .where(eq(modules.courseId, courseId));
}

export type CourseProgressSummary = {
  enrolledCount: number;
  totalLessons: number;
  /** 0–100, averaged over enrollees. Null when there is nothing to divide by. */
  averageProgressPercent: number | null;
  finishedCount: number;
};

/**
 * How far the enrolled students have got, as two figures rather than one.
 *
 * Average progress and the finished count answer different questions and
 * routinely disagree — a course everyone is halfway through has healthy
 * progress and no completions. Naming one of them "the completion rate" would
 * be wrong for whichever definition the reader had in mind.
 *
 * Progress counts lessons, not their duration: duration is nullable, seeded
 * durations are guesses, and a three-minute lesson that sends a student off to
 * build something for an afternoon is not a smaller piece of work.
 */
export function getCourseProgressSummary(
  courseId: number
): CourseProgressSummary {
  const totals = db
    .select({ totalLessons: count(lessons.id) })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .where(eq(modules.courseId, courseId))
    .get();

  const totalLessons = totals?.totalLessons ?? 0;

  // One grouped row per enrollee, including the ones who never started: a
  // student who bought and vanished is the finding, so a left join keeps them.
  const perStudent = db
    .select({
      userId: enrollments.userId,
      completed: countDistinct(lessonProgress.lessonId),
    })
    .from(enrollments)
    .leftJoin(
      lessonProgress,
      and(
        eq(lessonProgress.userId, enrollments.userId),
        eq(lessonProgress.status, LessonProgressStatus.Completed),
        inArray(lessonProgress.lessonId, courseLessonIds(courseId))
      )
    )
    .where(eq(enrollments.courseId, courseId))
    .groupBy(enrollments.userId)
    .all();

  if (perStudent.length === 0 || totalLessons === 0) {
    return {
      enrolledCount: perStudent.length,
      totalLessons,
      averageProgressPercent: null,
      finishedCount: 0,
    };
  }

  const totalPercent = perStudent.reduce(
    (running, student) => running + (student.completed / totalLessons) * 100,
    0
  );

  return {
    enrolledCount: perStudent.length,
    totalLessons,
    averageProgressPercent: Math.round(totalPercent / perStudent.length),
    finishedCount: perStudent.filter(
      (student) => student.completed >= totalLessons
    ).length,
  };
}

/** One bar of the drop-off funnel. */
export type FunnelLesson = {
  lessonId: number;
  title: string;
  /** Students who got at least this far, in progress or completed. */
  reachedCount: number;
  /**
   * Students lost between the previous bar and this one. The first lesson's
   * drop is measured from the enrolled count, so buying and never opening the
   * course shows up as the drop it is.
   */
  dropFromPrevious: number;
};

export type FunnelModule = {
  moduleId: number;
  title: string;
  /** Students who reached the module at all — its first lesson's bar. */
  reachedCount: number;
  /** Students the module lost between its first lesson and its last. */
  dropWithin: number;
  lessons: FunnelLesson[];
};

export type CourseFunnel = {
  enrolledCount: number;
  modules: FunnelModule[];
};

/** A lesson a student has opened counts as reached; one they haven't doesn't. */
const REACHED_STATUSES = [
  LessonProgressStatus.InProgress,
  LessonProgressStatus.Completed,
];

/**
 * Where students stop, one bar per lesson, grouped under module headings.
 *
 * Each bar counts students who reached *at least* that lesson rather than
 * those who completed that exact one, which is what makes the series descend:
 * a student who stops is absent from every later bar, so a gap between
 * neighbours is unambiguously the point people quit. Counting exact
 * completions instead produces a zigzag in which a skipped lesson is
 * indistinguishable from a lost student.
 *
 * "At least this far" is read from the furthest lesson each student has
 * touched, so skipping a lesson and carrying on leaves no dent in the funnel.
 */
export function getCourseDropOff(courseId: number): CourseFunnel {
  const enrolled = db
    .select({ enrolledCount: countDistinct(enrollments.userId) })
    .from(enrollments)
    .where(eq(enrollments.courseId, courseId))
    .get();

  const enrolledCount = enrolled?.enrolledCount ?? 0;

  const curriculum = db
    .select({
      moduleId: modules.id,
      moduleTitle: modules.title,
      lessonId: lessons.id,
      lessonTitle: lessons.title,
    })
    .from(modules)
    .innerJoin(lessons, eq(lessons.moduleId, modules.id))
    .where(eq(modules.courseId, courseId))
    .orderBy(modules.position, lessons.position)
    .all();

  if (curriculum.length === 0) return { enrolledCount, modules: [] };

  const positionOf = new Map(
    curriculum.map((row, position) => [row.lessonId, position])
  );

  // Enrolment is joined rather than filtered afterwards, so somebody working
  // through a course they never enrolled in cannot inflate a bar past the
  // denominator underneath it.
  const touched = db
    .selectDistinct({
      userId: lessonProgress.userId,
      lessonId: lessonProgress.lessonId,
    })
    .from(lessonProgress)
    .innerJoin(
      enrollments,
      and(
        eq(enrollments.userId, lessonProgress.userId),
        eq(enrollments.courseId, courseId)
      )
    )
    .where(
      and(
        inArray(lessonProgress.lessonId, courseLessonIds(courseId)),
        inArray(lessonProgress.status, REACHED_STATUSES)
      )
    )
    .all();

  const furthest = new Map<number, number>();
  for (const row of touched) {
    const position = positionOf.get(row.lessonId);
    if (position === undefined) continue;
    furthest.set(
      row.userId,
      Math.max(furthest.get(row.userId) ?? -1, position)
    );
  }

  // Counted backwards from the end: everyone who stopped at a later lesson
  // passed through this one, which is the whole definition of the bar.
  const stoppedAt = curriculum.map(() => 0);
  for (const position of furthest.values()) stoppedAt[position] += 1;

  const reachedAt: number[] = [];
  let running = 0;
  for (let position = curriculum.length - 1; position >= 0; position--) {
    running += stoppedAt[position];
    reachedAt[position] = running;
  }

  const grouped: FunnelModule[] = [];
  let previousReached = enrolledCount;

  curriculum.forEach((row, position) => {
    const reachedCount = reachedAt[position];
    const lesson: FunnelLesson = {
      lessonId: row.lessonId,
      title: row.lessonTitle,
      reachedCount,
      dropFromPrevious: previousReached - reachedCount,
    };
    previousReached = reachedCount;

    const current = grouped.at(-1);
    if (current?.moduleId === row.moduleId) {
      current.lessons.push(lesson);
      current.dropWithin = current.reachedCount - reachedCount;
    } else {
      grouped.push({
        moduleId: row.moduleId,
        title: row.moduleTitle,
        reachedCount,
        dropWithin: 0,
        lessons: [lesson],
      });
    }
  });

  return { enrolledCount, modules: grouped };
}

export type QuizPassRate = {
  quizId: number;
  title: string;
  moduleTitle: string;
  lessonTitle: string;
  /** The threshold as a percentage, for stating it beside the rate. */
  passingScorePercent: number;
  /** Students with at least one attempt in the range. */
  studentCount: number;
  passedCount: number;
  /** 0–100, or null when nobody has attempted it. */
  passRatePercent: number | null;
  averageBestScorePercent: number | null;
};

/**
 * How each quiz in a course is going, one row per quiz in course order.
 *
 * Counted per student on their best attempt, not per attempt: retakes are
 * allowed and encouraged, so counting attempts would score a quiz by how many
 * goes people needed rather than by whether they got there — and the student
 * roster already reports best attempts, so a second definition here would put
 * two different numbers for the same student on two pages.
 *
 * Passing is the verdict recorded on that attempt, not the score compared
 * against the quiz's passing score today. The threshold is editable, so
 * re-deciding it here would make this panel and the student roster disagree
 * about the same student — and the roster reports the stored flag.
 *
 * Quizzes nobody has attempted are listed with a null rate rather than a zero
 * one: "nobody has taken it" and "everybody failed it" call for opposite
 * reactions from an instructor.
 */
export function getCourseQuizPassRates(
  courseId: number,
  range: AnalyticsRange
): QuizPassRate[] {
  const quizRows = db
    .select({
      quizId: quizzes.id,
      title: quizzes.title,
      passingScore: quizzes.passingScore,
      moduleTitle: modules.title,
      lessonTitle: lessons.title,
    })
    .from(quizzes)
    .innerJoin(lessons, eq(quizzes.lessonId, lessons.id))
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .where(eq(modules.courseId, courseId))
    .orderBy(modules.position, lessons.position, quizzes.id)
    .all();

  // Sparse by design — most lessons carry no quiz, and plenty of courses carry
  // none at all. The caller says so on screen rather than drawing an empty panel.
  if (quizRows.length === 0) return [];

  const quizIds = quizRows.map((quiz) => quiz.quizId);

  // One row per student per quiz, holding the best they managed. Unlike the
  // progress panels above, attempts are timestamped, so this one can honour
  // the range control.
  //
  // `passed` and `score` are selected bare beside `max(score)`: SQLite answers
  // those from the very row the maximum came from, which is how the best
  // attempt's own recorded verdict is read rather than a fresh comparison.
  const bestAttempts = db
    .select({
      quizId: quizAttempts.quizId,
      bestScore: sql<number>`max(${quizAttempts.score})`.as("best_score"),
      passed: sql<number>`${quizAttempts.passed}`.as("best_passed"),
    })
    .from(quizAttempts)
    .where(
      and(
        inArray(quizAttempts.quizId, quizIds),
        since(quizAttempts.attemptedAt, range)
      )
    )
    .groupBy(quizAttempts.quizId, quizAttempts.userId)
    .as("best_attempts");

  const stats = db
    .select({
      quizId: bestAttempts.quizId,
      studentCount: count(),
      passedCount: sql<number>`sum(${bestAttempts.passed})`,
      averageBestScore: sql<number>`avg(${bestAttempts.bestScore})`,
    })
    .from(bestAttempts)
    .groupBy(bestAttempts.quizId)
    .all();

  const statsByQuiz = new Map(stats.map((row) => [row.quizId, row]));

  return quizRows.map((quiz) => {
    const row = statsByQuiz.get(quiz.quizId);
    const studentCount = row?.studentCount ?? 0;
    const passedCount = Number(row?.passedCount ?? 0);

    return {
      quizId: quiz.quizId,
      title: quiz.title,
      moduleTitle: quiz.moduleTitle,
      lessonTitle: quiz.lessonTitle,
      passingScorePercent: Math.round(quiz.passingScore * 100),
      studentCount,
      passedCount,
      passRatePercent:
        studentCount === 0
          ? null
          : Math.round((passedCount / studentCount) * 100),
      averageBestScorePercent:
        studentCount === 0
          ? null
          : Math.round(Number(row?.averageBestScore ?? 0) * 100),
    };
  });
}

export type CountryRevenueRow = {
  /** Null for purchases made before a country was recorded, or without one. */
  country: string | null;
  purchaseCount: number;
  grossCents: number;
  /** What the instructor keeps of it, on the same split as every other panel. */
  netCents: number;
  /** Share of the course's revenue in the range, 0–100. */
  sharePercent: number;
  averagePaidCents: number;
  /**
   * The parity discount this country is offered *today*, 0–100, or null when
   * no country was recorded. A fact about current pricing, not a claim about
   * what any particular buyer was charged.
   */
  discountPercent: number | null;
};

export type CourseCountryRevenue = {
  grossCents: number;
  netCents: number;
  purchaseCount: number;
  /** Revenue from countries that currently get a parity discount. */
  discountedGrossCents: number;
  discountedNetCents: number;
  discountedSharePercent: number;
  rows: CountryRevenueRow[];
};

/**
 * Where a course's buyers are, and what each country is worth.
 *
 * Purchasing-power-parity discounting is otherwise invisible to an instructor
 * even though it directly sets what they earn, so each row carries the average
 * a sale there fetched alongside the discount that country is currently
 * offered.
 *
 * What was actually discounted off any given purchase is *not* reported, and
 * cannot be: course prices are mutable and no price history is kept, so a
 * discount reconstructed from today's price would be fiction for every sale
 * made before the last price change. Country, revenue and the average paid are
 * all recorded facts.
 *
 * Purchases with no country are their own row rather than dropped, so the rows
 * still sum to the revenue the rest of the page reports, and never count as
 * discounted — nothing is known about them either way.
 *
 * Gross and net both travel with every row, on the same split as every other
 * money figure on the page: the question being asked is what a region is worth
 * to the instructor, and that is the net.
 */
export function getCourseRevenueByCountry(
  courseId: number,
  range: AnalyticsRange
): CourseCountryRevenue {
  const rows = db
    .select({
      country: purchases.country,
      gross: sum(purchases.amountPaid),
      purchaseCount: count(purchases.id),
    })
    .from(purchases)
    .where(
      and(eq(purchases.courseId, courseId), since(purchases.createdAt, range))
    )
    .groupBy(purchases.country)
    .all()
    .map((row) => ({
      country: row.country,
      grossCents: Number(row.gross ?? 0),
      purchaseCount: row.purchaseCount,
    }))
    .sort((a, b) => b.grossCents - a.grossCents);

  const grossCents = rows.reduce((total, row) => total + row.grossCents, 0);
  const purchaseCount = rows.reduce(
    (total, row) => total + row.purchaseCount,
    0
  );

  const share = (cents: number) =>
    grossCents === 0 ? 0 : Math.round((cents / grossCents) * 100);

  let discountedGrossCents = 0;

  const breakdown = rows.map((row) => {
    const discountPercent =
      row.country === null ? null : getDiscountForCountry(row.country) * 100;

    if (discountPercent !== null && discountPercent > 0) {
      discountedGrossCents += row.grossCents;
    }

    return {
      ...row,
      netCents: splitRevenue(row.grossCents).netCents,
      sharePercent: share(row.grossCents),
      averagePaidCents: Math.round(row.grossCents / row.purchaseCount),
      discountPercent,
    };
  });

  return {
    grossCents,
    netCents: splitRevenue(grossCents).netCents,
    purchaseCount,
    discountedGrossCents,
    discountedNetCents: splitRevenue(discountedGrossCents).netCents,
    discountedSharePercent: share(discountedGrossCents),
    rows: breakdown,
  };
}

/**
 * The courses on the Course detail tab's selector, alphabetically.
 *
 * Every course the instructor owns, drafts included — a draft with enrolled
 * testers still has a funnel worth looking at, and a course missing from the
 * list reads as data loss. A null instructor spans the platform, for the
 * admin's view.
 */
export function listInstructorCourses(
  instructorId: number | null
): { courseId: number; title: string }[] {
  return db
    .select({ courseId: courses.id, title: courses.title })
    .from(courses)
    .where(ownedBy(instructorId))
    .orderBy(courses.title)
    .all();
}
