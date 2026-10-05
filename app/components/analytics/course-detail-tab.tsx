import { Users } from "lucide-react";
import type {
  AnalyticsCourse,
  CountryRevenueSummary,
  CourseDetail,
  Funnel,
  QuizPassRate,
} from "~/services/analyticsService";
import { ANALYTICS_RANGE_LABELS, type AnalyticsRange } from "~/lib/analytics";
import { COUNTRIES } from "~/lib/ppp";
import { formatCents } from "~/lib/utils";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { CourseSelect } from "~/components/analytics/controls";
import {
  PanelEmpty,
  ProgressBar,
  tableHeadClass,
} from "~/components/analytics/shared";

// ─── Analytics: Course detail tab ───
// The deep dive on one course. Each panel takes one key of getCourseDetail's
// result.

/**
 * The course picker and the panels for the picked course. `courseDetail` is
 * null until the loader has a course to show.
 */
export function CourseDetailTab({
  courses,
  selectedCourse,
  courseDetail,
  range,
}: {
  courses: AnalyticsCourse[];
  selectedCourse: AnalyticsCourse | null;
  courseDetail: CourseDetail | null;
  range: AnalyticsRange;
}) {
  if (!selectedCourse) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-muted-foreground">
          There are no courses to show.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <CourseSelect courses={courses} selectedCourse={selectedCourse} />
      {courseDetail && (
        <>
          {courseDetail.progress.enrolledCount === 0 ? (
            <NoEnrolledStudents />
          ) : (
            <>
              <ProgressFigures progress={courseDetail.progress} />
              <DropOffFunnel funnel={courseDetail.funnel} />
            </>
          )}
          <QuizPassRates quizzes={courseDetail.quizPassRates} range={range} />
          <RevenueByCountry
            revenue={courseDetail.countryRevenue}
            range={range}
          />
        </>
      )}
    </div>
  );
}

const ALL_TIME_NOTE = "All time: lesson progress has no start date.";

function NoEnrolledStudents() {
  return (
    <Card>
      <CardContent className="py-12 text-center">
        <Users className="mx-auto mb-4 size-12 text-muted-foreground/50" />
        <p className="font-medium">No students enrolled yet</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Progress and lesson drop-off appear here once students enrol in this
          course.
        </p>
      </CardContent>
    </Card>
  );
}

function ProgressFigures({ progress }: { progress: CourseDetail["progress"] }) {
  const finishedPercent =
    progress.enrolledCount === 0
      ? 0
      : Math.round((progress.finishedCount / progress.enrolledCount) * 100);
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card>
        <CardHeader>
          <CardDescription>Average progress</CardDescription>
          <CardTitle className="text-3xl tabular-nums">
            {progress.averageProgressPercent}%
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-xs text-muted-foreground">
          <ProgressBar percent={progress.averageProgressPercent} />
          <p>
            Lessons completed over total lessons, averaged over{" "}
            {progress.enrolledCount} enrolled students. {ALL_TIME_NOTE}
          </p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardDescription>Finished the course</CardDescription>
          <CardTitle className="text-3xl tabular-nums">
            {progress.finishedCount}{" "}
            <span className="text-base font-normal text-muted-foreground">
              of {progress.enrolledCount}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-xs text-muted-foreground">
          <ProgressBar percent={finishedPercent} />
          <p>Students who completed every lesson. {ALL_TIME_NOTE}</p>
        </CardContent>
      </Card>
    </div>
  );
}

function DropCount({
  count,
  isBiggest,
}: {
  count: number;
  isBiggest: boolean;
}) {
  if (count === 0) {
    return <span className="text-muted-foreground/50">—</span>;
  }
  return (
    <span
      className={
        isBiggest
          ? "font-semibold text-red-600 dark:text-red-400"
          : "text-muted-foreground"
      }
    >
      −{count}
    </span>
  );
}

/**
 * One bar per lesson: students who reached at least that lesson, of everyone
 * enrolled. The series only descends, so the widest gap is where students
 * quit.
 */
function DropOffFunnel({ funnel }: { funnel: Funnel }) {
  const lessons = funnel.modules.flatMap(
    (funnelModule) => funnelModule.lessons
  );
  const biggestDrop = Math.max(0, ...lessons.map((lesson) => lesson.dropCount));
  const percentOf = (count: number) =>
    funnel.enrolledCount === 0 ? 0 : (count / funnel.enrolledCount) * 100;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Lesson drop-off</CardTitle>
        <CardDescription>
          Students who reached at least each lesson, of {funnel.enrolledCount}{" "}
          enrolled. A skipped lesson is not a drop. The number on the right is
          how many students stopped before the lesson. {ALL_TIME_NOTE}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {lessons.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            This course has no lessons yet.
          </p>
        ) : (
          <div className="space-y-6">
            {funnel.modules.map((funnelModule) => (
              <section key={funnelModule.id} aria-label={funnelModule.title}>
                <div className="mb-2 flex items-baseline justify-between gap-4 border-b border-border pb-1">
                  <h3 className="text-sm font-semibold">
                    {funnelModule.title}
                  </h3>
                  <p className="text-xs text-muted-foreground tabular-nums">
                    {funnelModule.reachedCount} reached ·{" "}
                    {funnelModule.dropCount} lost
                  </p>
                </div>
                <ol className="space-y-1.5">
                  {funnelModule.lessons.map((lesson) => (
                    <li
                      key={lesson.id}
                      className="grid grid-cols-[minmax(0,14rem)_1fr_3rem_3rem] items-center gap-3 text-sm"
                    >
                      <span className="truncate" title={lesson.title}>
                        {lesson.title}
                      </span>
                      <div className="h-2 w-full rounded-full bg-muted">
                        <div
                          className="h-2 rounded-full bg-primary transition-all"
                          style={{
                            width: `${percentOf(lesson.reachedCount)}%`,
                          }}
                        />
                      </div>
                      <span className="text-right tabular-nums">
                        {lesson.reachedCount}
                      </span>
                      <span className="text-right text-xs tabular-nums">
                        <DropCount
                          count={lesson.dropCount}
                          isBiggest={lesson.dropCount === biggestDrop}
                        />
                      </span>
                    </li>
                  ))}
                </ol>
              </section>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * One row per quiz in course order. A rate counts each student once, by their
 * best attempt, so retakes do not drag it down.
 */
function QuizPassRates({
  quizzes,
  range,
}: {
  quizzes: QuizPassRate[];
  range: AnalyticsRange;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Quiz pass rates</CardTitle>
        <CardDescription>
          Each student counts once per quiz, by their best attempt (highest
          score). Attempts made {ANALYTICS_RANGE_LABELS[range].toLowerCase()}.
        </CardDescription>
      </CardHeader>
      <CardContent className={quizzes.length === 0 ? undefined : "p-0"}>
        {quizzes.length === 0 ? (
          <PanelEmpty
            title="This course has no quizzes"
            body="Add a quiz to a lesson to see how students do on it. Most lessons have none, and that is fine."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-y border-border bg-muted/50">
                  <th className={tableHeadClass}>Quiz</th>
                  <th className={tableHeadClass}>Pass rate</th>
                  <th className={`${tableHeadClass} text-right`}>Passed</th>
                </tr>
              </thead>
              <tbody>
                {quizzes.map((quiz) => (
                  <tr
                    key={quiz.quizId}
                    className="border-b border-border last:border-0"
                  >
                    <td className="px-4 py-3">
                      <div className="font-medium">{quiz.title}</div>
                      <div className="text-xs text-muted-foreground">
                        {quiz.lessonTitle}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      {quiz.passRatePercent === null ? (
                        <span className="text-sm text-muted-foreground">
                          No attempts in this period
                        </span>
                      ) : (
                        <div className="flex items-center gap-3">
                          <div className="w-32">
                            <ProgressBar percent={quiz.passRatePercent} />
                          </div>
                          <span className="text-sm font-medium tabular-nums">
                            {quiz.passRatePercent}%
                          </span>
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right text-sm tabular-nums">
                      {quiz.passedCount} of {quiz.studentCount}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

const countryNames = new Map(COUNTRIES.map(({ code, name }) => [code, name]));

function countryName(code: string | null): string {
  if (code === null) return "Unknown";
  return countryNames.get(code) ?? code;
}

/**
 * Where the course's money comes from. The discount a buyer got is not
 * stored, so each country shows its current PPP tier, not a reconstructed
 * discount.
 */
function RevenueByCountry({
  revenue,
  range,
}: {
  revenue: CountryRevenueSummary;
  range: AnalyticsRange;
}) {
  const period = ANALYTICS_RANGE_LABELS[range].toLowerCase();
  const discountedPercent =
    revenue.totalCents === 0
      ? 0
      : Math.round((revenue.discountedCents / revenue.totalCents) * 100);
  const percentOf = (cents: number) =>
    revenue.totalCents === 0 ? 0 : (cents / revenue.totalCents) * 100;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Revenue by country</CardTitle>
        <CardDescription>
          This course's purchases by buyer country, {period}. A team purchase
          counts once, at its full amount.
        </CardDescription>
      </CardHeader>
      <CardContent
        className={revenue.countries.length === 0 ? undefined : "p-0"}
      >
        {revenue.countries.length === 0 ? (
          <PanelEmpty
            title="No sales in this period"
            body="Buyer countries appear here once people buy this course. Try a longer range."
          />
        ) : (
          <>
            <div className="space-y-2 px-6 pb-4">
              <p className="text-sm">
                <span className="font-semibold tabular-nums">
                  {formatCents(revenue.discountedCents)}
                </span>{" "}
                of {formatCents(revenue.totalCents)} ({discountedPercent}%) came
                from regions with a purchasing-power discount.
              </p>
              <ProgressBar percent={discountedPercent} />
              <p className="text-xs text-muted-foreground">
                The discount column is each country's current tier, or full
                price for every country when this course has PPP turned off. The
                discount a buyer actually got is not recorded.
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-y border-border bg-muted/50">
                    <th className={tableHeadClass}>Country</th>
                    <th className={tableHeadClass}>Discount tier</th>
                    <th className={`${tableHeadClass} text-right`}>
                      Purchases
                    </th>
                    <th className={tableHeadClass}>Share</th>
                    <th className={`${tableHeadClass} text-right`}>Revenue</th>
                  </tr>
                </thead>
                <tbody>
                  {revenue.countries.map((row) => (
                    <tr
                      key={row.country ?? "unknown"}
                      className="border-b border-border last:border-0"
                    >
                      <td className="px-4 py-3 font-medium">
                        {countryName(row.country)}
                      </td>
                      <td className="px-4 py-3 text-sm">
                        {row.discountLabel === null ? (
                          <span className="text-muted-foreground">
                            No country recorded
                          </span>
                        ) : row.discounted ? (
                          <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900/30 dark:text-amber-400">
                            {row.discountLabel}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">
                            {row.discountLabel}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right text-sm tabular-nums">
                        {row.purchaseCount}
                      </td>
                      <td className="px-4 py-3">
                        <div className="w-32">
                          <ProgressBar percent={percentOf(row.revenueCents)} />
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right font-medium tabular-nums">
                        {formatCents(row.revenueCents)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
