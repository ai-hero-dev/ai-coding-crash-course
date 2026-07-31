import { Link, isRouteErrorResponse, useSearchParams } from "react-router";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import type { Route } from "./+types/instructor.analytics";
import { requireInstructorOrAdmin } from "~/lib/access.server";
import {
  getAudienceSummary,
  getCourseDropOff,
  getCourseProgressSummary,
  getCourseQuizPassRates,
  getCourseRevenueByCountry,
  getRatingSummary,
  getRevenueByCourse,
  getRevenueOverTime,
  getRevenueSummary,
  getTopBuyers,
  hasPublishedCourses,
  listCourseOwners,
  listInstructorCourses,
  type CourseCountryRevenue,
  type CourseFunnel,
  type CourseProgressSummary,
  type FunnelLesson,
  type QuizPassRate,
  type RevenueSeries,
} from "~/services/analyticsService";
import { getUnansweredCounts } from "~/services/commentService";
import {
  ANALYTICS_RANGES,
  PLATFORM_FEE_PERCENT,
  formatBucket,
  formatMoney,
  parseAnalyticsRange,
  rangeStart,
} from "~/lib/analytics";
import { countryName } from "~/lib/ppp";
import { Button } from "~/components/ui/button";
import { Card, CardContent } from "~/components/ui/card";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "~/components/ui/chart";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Skeleton } from "~/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "~/components/ui/tabs";
import { AlertTriangle, Rocket } from "lucide-react";

// ─── Instructor Analytics ───
// What an instructor earned, and when. Three money figures rather than one:
// a lone number here gets read as "what I get paid", and the platform's 20%
// cut makes that reading wrong.
//
// All page state — tab, range, instructor, course — lives in search params, so
// a view can be linked to and reloaded. The loader reads them; the controls
// write them and let the loader re-run.
//
// Admins additionally get an instructor picker. With none picked the service
// receives a null instructor, meaning platform-wide.

// "course" is the second tab; anything else falls back to the overview.
type AnalyticsTab = "overview" | "course";

const chartConfig = {
  grossCents: { label: "Gross revenue", color: "var(--chart-1)" },
  netCents: { label: "Net earnings", color: "var(--chart-2)" },
} satisfies ChartConfig;

export function meta() {
  return [
    { title: "Analytics — Cadence" },
    { name: "description", content: "Revenue and earnings for your courses." },
  ];
}

/** A search param that should be a row id, or null if it isn't one. */
function parseId(value: string | null): number | null {
  const id = Number(value);
  return value !== null && Number.isInteger(id) && id > 0 ? id : null;
}

export async function loader({ request }: Route.LoaderArgs) {
  const { userId, isAdmin } = await requireInstructorOrAdmin(request);

  const url = new URL(request.url);
  const range = parseAnalyticsRange(url.searchParams.get("range"));
  const tab: AnalyticsTab =
    url.searchParams.get("tab") === "course" ? "course" : "overview";

  // Instructors are pinned to their own figures; only an admin may look
  // elsewhere, and null means "every instructor".
  const instructorId = isAdmin
    ? parseId(url.searchParams.get("instructor"))
    : userId;

  // The selector lists every course the viewer owns rather than only the ones
  // that sold: a course nobody is finishing is exactly what this tab is for.
  const courseOptions = listInstructorCourses(instructorId);
  const requestedCourseId = parseId(url.searchParams.get("course"));
  // Checked against the list rather than trusted: the id arrives in the URL,
  // and an instructor may not read another instructor's funnel.
  const selectedCourseId = courseOptions.some(
    (course) => course.courseId === requestedCourseId
  )
    ? requestedCourseId
    : null;

  return {
    // Split rather than filtered: the range applies, but questions older than
    // it are still reported, because months of silence is the urgent case.
    questions: getUnansweredCounts(instructorId, rangeStart(range)),
    audience: getAudienceSummary(instructorId, range),
    buyers: getTopBuyers(instructorId, range),
    ratings: getRatingSummary(instructorId, range),
    tab,
    range,
    isAdmin,
    instructorId,
    selectedCourseId,
    summary: getRevenueSummary(instructorId, range),
    series: getRevenueOverTime(instructorId, range),
    courses: getRevenueByCourse(instructorId, range),
    courseOptions,
    // Progress and drop-off carry no usable timestamp, so they span all time
    // whatever the range control says — and the tab says so on screen.
    progress:
      selectedCourseId === null
        ? null
        : getCourseProgressSummary(selectedCourseId),
    funnel:
      selectedCourseId === null ? null : getCourseDropOff(selectedCourseId),
    // Quiz attempts and purchases are both timestamped, so unlike the two
    // panels above these do honour the range control.
    quizzes:
      selectedCourseId === null
        ? null
        : getCourseQuizPassRates(selectedCourseId, range),
    countries:
      selectedCourseId === null
        ? null
        : getCourseRevenueByCountry(selectedCourseId, range),
    instructors: isAdmin ? listCourseOwners() : [],
    // The platform-wide view always has courses in it, so the "publish
    // something" prompt only makes sense for one named instructor.
    unpublished: instructorId !== null && !hasPublishedCourses(instructorId),
  };
}

function MoneyCard({
  label,
  amountCents,
  hint,
  emphasis,
}: {
  label: string;
  amountCents: number;
  hint: string;
  emphasis?: boolean;
}) {
  return (
    <Card>
      <CardContent className="p-6">
        <div className="text-sm font-medium text-muted-foreground">{label}</div>
        <div
          className={
            emphasis
              ? "mt-2 text-3xl font-bold text-primary"
              : "mt-2 text-3xl font-bold"
          }
        >
          {formatMoney(amountCents)}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
      </CardContent>
    </Card>
  );
}

/**
 * A single figure with its own empty copy.
 *
 * Every panel says what it means when it has nothing, so an instructor can
 * tell "nothing has happened yet" from "this is broken".
 */
function StatCard({
  label,
  value,
  hint,
  emptyHint,
  action,
}: {
  label: string;
  value: string | number;
  hint: string;
  /** Shown instead of `hint` when the figure is zero — and greys the figure. */
  emptyHint?: string;
  action?: React.ReactNode;
}) {
  const empty = emptyHint !== undefined && (value === 0 || value === "—");

  return (
    <Card>
      <CardContent className="p-6">
        <div className="text-sm font-medium text-muted-foreground">{label}</div>
        <div
          className={
            empty
              ? "mt-2 text-3xl font-bold text-muted-foreground"
              : "mt-2 text-3xl font-bold"
          }
        >
          {value}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {empty ? emptyHint : hint}
        </p>
        {action}
      </CardContent>
    </Card>
  );
}

function TopBuyers({
  buyers,
}: {
  buyers: Route.ComponentProps["loaderData"]["buyers"];
}) {
  if (buyers.length === 0) {
    return (
      <p className="py-12 text-center text-sm text-muted-foreground">
        Nobody has bought anything in this period, so there is nobody to reach
        out to yet.
      </p>
    );
  }

  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b text-left text-muted-foreground">
          <th className="pb-2 font-medium">Buyer</th>
          <th className="pb-2 font-medium">Seats</th>
          <th className="pb-2 text-right font-medium">Purchases</th>
          <th className="pb-2 text-right font-medium">Total spend</th>
        </tr>
      </thead>
      <tbody>
        {buyers.map((buyer) => (
          <tr key={buyer.userId} className="border-b">
            <td className="py-3">
              <div className="font-medium">{buyer.name}</div>
              <div className="text-xs text-muted-foreground">{buyer.email}</div>
            </td>
            <td className="py-3">
              {buyer.seatsBought > 0 && (
                <div>
                  <span className="rounded bg-secondary px-1.5 py-0.5 text-xs font-medium">
                    Team
                  </span>{" "}
                  <span className="text-xs text-muted-foreground">
                    bought {buyer.seatsBought},{" "}
                    {buyer.seatsUnredeemed > 0 ? (
                      // The prompt to chase: seats paid for that nobody is
                      // using are the most actionable thing on this table.
                      <span className="font-medium text-foreground">
                        {buyer.seatsUnredeemed} unused
                      </span>
                    ) : (
                      "all claimed"
                    )}
                  </span>
                </div>
              )}
              {/* Said of team buyers too, not just solo ones: the manager who
                  bought a dozen seats and never opened the course is the very
                  person this table exists to surface. */}
              <div className="text-xs text-muted-foreground">
                {buyer.enrolled ? "Enrolled" : "Never enrolled"}
              </div>
            </td>
            <td className="py-3 text-right tabular-nums">
              {buyer.purchaseCount}
            </td>
            <td className="py-3 text-right font-medium tabular-nums">
              {formatMoney(buyer.spendCents)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function RevenueChart({ series }: { series: RevenueSeries }) {
  return (
    <ChartContainer config={chartConfig} className="h-64 w-full">
      <AreaChart data={series.points} margin={{ left: 12, right: 12 }}>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="bucket"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          minTickGap={24}
          tickFormatter={formatBucket}
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          width={72}
          tickFormatter={(cents: number) => formatMoney(cents)}
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              labelFormatter={(label) => formatBucket(String(label))}
              formatter={(value, name) => (
                <span className="flex w-full justify-between gap-4">
                  <span className="text-muted-foreground">
                    {chartConfig[name as keyof typeof chartConfig]?.label ??
                      name}
                  </span>
                  <span className="font-mono font-medium">
                    {formatMoney(Number(value))}
                  </span>
                </span>
              )}
            />
          }
        />
        <Area
          dataKey="grossCents"
          type="monotone"
          stroke="var(--color-grossCents)"
          fill="var(--color-grossCents)"
          fillOpacity={0.2}
        />
        <Area
          dataKey="netCents"
          type="monotone"
          stroke="var(--color-netCents)"
          fill="var(--color-netCents)"
          fillOpacity={0.2}
        />
      </AreaChart>
    </ChartContainer>
  );
}

/** The two completion figures, side by side and deliberately not merged. */
function CourseProgress({ progress }: { progress: CourseProgressSummary }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Card>
        <CardContent className="p-6">
          <div className="text-sm font-medium text-muted-foreground">
            Average progress <span className="font-normal">· all time</span>
          </div>
          <div className="mt-2 text-3xl font-bold">
            {progress.averageProgressPercent === null
              ? "—"
              : `${progress.averageProgressPercent}%`}
          </div>
          <div className="mt-3 h-2 w-full rounded-full bg-muted">
            <div
              className="h-2 rounded-full bg-primary transition-all"
              style={{ width: `${progress.averageProgressPercent ?? 0}%` }}
            />
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Lessons completed per enrolled student, across{" "}
            {progress.enrolledCount}{" "}
            {progress.enrolledCount === 1 ? "student" : "students"} and{" "}
            {progress.totalLessons}{" "}
            {progress.totalLessons === 1 ? "lesson" : "lessons"}.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-6">
          <div className="text-sm font-medium text-muted-foreground">
            Students finished <span className="font-normal">· all time</span>
          </div>
          <div className="mt-2 text-3xl font-bold">
            {progress.finishedCount}
          </div>
          {/* A count, and deliberately not a third percentage: several
              defensible completion rates exist, they disagree, and naming one
              of them here would be wrong for whoever is reading. */}
          <p className="mt-2 text-xs text-muted-foreground">
            Students who have completed every lesson, of{" "}
            {progress.enrolledCount} enrolled.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

/** One lesson's bar, sized against the enrolled count. */
function FunnelRow({
  lesson,
  enrolledCount,
}: {
  lesson: FunnelLesson;
  enrolledCount: number;
}) {
  const share =
    enrolledCount === 0 ? 0 : (lesson.reachedCount / enrolledCount) * 100;

  return (
    <div className="flex items-center gap-3 py-1.5 text-sm">
      <div
        className="w-48 shrink-0 truncate text-muted-foreground"
        title={lesson.title}
      >
        {lesson.title}
      </div>
      <div className="h-4 flex-1 rounded bg-muted">
        <div
          className="h-4 rounded bg-primary/70 transition-all"
          style={{ width: `${share}%` }}
        />
      </div>
      <div className="w-10 shrink-0 text-right font-medium tabular-nums">
        {lesson.reachedCount}
      </div>
      {/* The drop is spelled out beside each bar so the worst lesson can be
          found by reading rather than by comparing bar lengths by eye. */}
      <div className="w-16 shrink-0 text-right text-xs tabular-nums">
        {lesson.dropFromPrevious > 0 ? (
          <span className="font-medium text-destructive">
            −{lesson.dropFromPrevious}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </div>
    </div>
  );
}

function DropOffFunnel({ funnel }: { funnel: CourseFunnel }) {
  if (funnel.modules.length === 0) {
    return (
      <p className="py-12 text-center text-sm text-muted-foreground">
        This course has no lessons yet, so there is nothing to drop off from.
      </p>
    );
  }

  return (
    <div className="space-y-5">
      {funnel.modules.map((module) => (
        <div key={module.moduleId}>
          {/* Grouped by module because that is how instructors talk about a
              course — "nobody survives module 3". */}
          <div className="flex items-baseline justify-between gap-4 border-b pb-1">
            <h3 className="text-sm font-semibold">{module.title}</h3>
            <p className="text-xs text-muted-foreground tabular-nums">
              {module.reachedCount} of {funnel.enrolledCount} reached
              {module.dropWithin > 0 && `, ${module.dropWithin} lost inside`}
            </p>
          </div>
          <div className="mt-2">
            {module.lessons.map((lesson) => (
              <FunnelRow
                key={lesson.lessonId}
                lesson={lesson}
                enrolledCount={funnel.enrolledCount}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * How each quiz is going, one row apiece.
 *
 * The basis is spelled out above the table rather than left implied: retakes
 * are allowed, so "pass rate" has more than one defensible meaning and the
 * reader cannot tell which one they are looking at from the number alone.
 */
function QuizPassRates({ quizzes }: { quizzes: QuizPassRate[] }) {
  if (quizzes.length === 0) {
    return (
      <p className="py-12 text-center text-sm text-muted-foreground">
        This course has no quizzes yet. Add one to a lesson to see how students
        do on it.
      </p>
    );
  }

  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b text-left text-muted-foreground">
          <th className="pb-2 font-medium">Quiz</th>
          <th className="pb-2 text-right font-medium">Students</th>
          <th className="pb-2 text-right font-medium">Passed</th>
          <th className="pb-2 text-right font-medium">Pass rate</th>
          <th className="pb-2 text-right font-medium">Average score</th>
        </tr>
      </thead>
      <tbody>
        {quizzes.map((quiz) => (
          <tr key={quiz.quizId} className="border-b">
            <td className="py-3">
              <div className="font-medium">{quiz.title}</div>
              <div className="text-xs text-muted-foreground">
                {quiz.moduleTitle} · {quiz.lessonTitle} · passes at{" "}
                {quiz.passingScorePercent}%
              </div>
            </td>
            {quiz.passRatePercent === null ? (
              // Untaken, not failed: a zero here would read as a quiz everyone
              // is flunking, which calls for the opposite reaction.
              <td
                className="py-3 text-right text-xs text-muted-foreground"
                colSpan={4}
              >
                Nobody has attempted this quiz in this period.
              </td>
            ) : (
              <>
                <td className="py-3 text-right tabular-nums">
                  {quiz.studentCount}
                </td>
                <td className="py-3 text-right tabular-nums">
                  {quiz.passedCount}
                </td>
                <td className="py-3 text-right font-medium tabular-nums">
                  {quiz.passRatePercent}%
                </td>
                <td className="py-3 text-right tabular-nums text-muted-foreground">
                  {quiz.averageBestScorePercent}%
                </td>
              </>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Where a course's buyers are, and what parity pricing costs the seller. */
function RevenueByCountry({ breakdown }: { breakdown: CourseCountryRevenue }) {
  if (breakdown.rows.length === 0) {
    return (
      <p className="py-12 text-center text-sm text-muted-foreground">
        This course has no sales in this period, so there is nowhere to break
        down yet.
      </p>
    );
  }

  return (
    <>
      <p className="mb-4 text-sm text-muted-foreground">
        {/* The headline the panel exists for: parity discounting is otherwise
            invisible, though it directly sets what the instructor earns — so
            the figure is stated in net, the money they actually keep. */}
        {formatMoney(breakdown.discountedNetCents)} of your{" "}
        {formatMoney(breakdown.netCents)} net earnings (
        {breakdown.discountedSharePercent}%) came from countries with a parity
        discount. Averages are what a sale there actually fetched — list prices
        change and are not kept, so no discount is reconstructed per purchase.
      </p>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-muted-foreground">
            <th className="pb-2 font-medium">Country</th>
            <th className="pb-2 text-right font-medium">Sales</th>
            <th className="pb-2 text-right font-medium">Average paid</th>
            <th className="pb-2 text-right font-medium">Gross</th>
            <th className="pb-2 text-right font-medium">Net</th>
            <th className="pb-2 text-right font-medium">Share</th>
          </tr>
        </thead>
        <tbody>
          {breakdown.rows.map((row) => (
            <tr key={row.country ?? "unknown"} className="border-b">
              <td className="py-3">
                <span className="font-medium">
                  {row.country === null
                    ? "Not recorded"
                    : countryName(row.country)}
                </span>
                {row.discountPercent !== null && row.discountPercent > 0 && (
                  <span className="ml-2 rounded bg-secondary px-1.5 py-0.5 text-xs font-medium">
                    {row.discountPercent}% off today
                  </span>
                )}
              </td>
              <td className="py-3 text-right tabular-nums">
                {row.purchaseCount}
              </td>
              <td className="py-3 text-right tabular-nums text-muted-foreground">
                {formatMoney(row.averagePaidCents)}
              </td>
              <td className="py-3 text-right tabular-nums">
                {formatMoney(row.grossCents)}
              </td>
              <td className="py-3 text-right font-medium tabular-nums">
                {formatMoney(row.netCents)}
              </td>
              <td className="py-3 text-right tabular-nums">
                <span className="mr-2">{row.sharePercent}%</span>
                <span className="inline-block h-2 w-16 rounded bg-muted align-middle">
                  <span
                    className="block h-2 rounded bg-primary/70"
                    style={{ width: `${row.sharePercent}%` }}
                  />
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

export default function InstructorAnalytics({
  loaderData,
}: Route.ComponentProps) {
  const {
    tab,
    range,
    isAdmin,
    instructorId,
    selectedCourseId,
    summary,
    series,
    courses,
    courseOptions,
    progress,
    funnel,
    quizzes,
    countries,
    instructors,
    unpublished,
    audience,
    buyers,
    questions,
    ratings,
  } = loaderData;

  const [searchParams, setSearchParams] = useSearchParams();

  // Every control writes one param and leaves the rest of the view intact.
  function setParam(key: string, value: string | null) {
    const next = new URLSearchParams(searchParams);
    if (value === null) {
      next.delete(key);
    } else {
      next.set(key, value);
    }
    setSearchParams(next);
  }

  const selectedCourse =
    courseOptions.find((course) => course.courseId === selectedCourseId) ??
    null;
  // The revenue table narrows to the selected course. One with no sales in the
  // range has no row at all, and the panel says so rather than sitting empty.
  const revenueRows = selectedCourse
    ? courses.filter((course) => course.courseId === selectedCourseId)
    : courses;

  return (
    <div className="mx-auto max-w-5xl p-6 lg:p-8">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">Analytics</h1>
          <p className="mt-1 text-muted-foreground">
            {isAdmin && instructorId === null
              ? "Revenue across every instructor on the platform."
              : "Revenue and earnings for your courses."}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {isAdmin && (
            <Select
              value={instructorId === null ? "all" : String(instructorId)}
              onValueChange={(value) =>
                setParam("instructor", value === "all" ? null : value)
              }
            >
              {/* SelectValue renders its selected item's text only once the
                  content has mounted, which never happens on the server — so
                  each trigger is given the label outright. */}
              <SelectTrigger aria-label="Instructor" className="w-56">
                <SelectValue>
                  {instructors.find((one) => one.id === instructorId)?.name ??
                    "All instructors"}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All instructors</SelectItem>
                {instructors.map((instructor) => (
                  <SelectItem key={instructor.id} value={String(instructor.id)}>
                    {instructor.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          <Select
            value={range}
            onValueChange={(value) => setParam("range", value)}
          >
            <SelectTrigger aria-label="Date range" className="w-40">
              <SelectValue>
                {
                  ANALYTICS_RANGES.find((option) => option.value === range)
                    ?.label
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {ANALYTICS_RANGES.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {unpublished ? (
        <Card>
          <CardContent className="py-12 text-center">
            <Rocket className="mx-auto mb-4 size-12 text-muted-foreground" />
            <p className="font-medium">No published courses yet</p>
            <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
              Analytics start the moment you make your first sale. Publish your
              first course to get going.
            </p>
            <Link to="/instructor/new" className="mt-6 inline-block">
              <Button>Publish your first course</Button>
            </Link>
          </CardContent>
        </Card>
      ) : (
        <Tabs value={tab} onValueChange={(value) => setParam("tab", value)}>
          <TabsList className="mb-4">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="course">Course detail</TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="space-y-6">
            <div className="grid gap-4 sm:grid-cols-3">
              <MoneyCard
                label="Gross revenue"
                amountCents={summary.grossCents}
                hint={`What students paid, across ${summary.purchaseCount} ${
                  summary.purchaseCount === 1 ? "purchase" : "purchases"
                }.`}
              />
              <MoneyCard
                label={`Platform fee (${PLATFORM_FEE_PERCENT}%)`}
                amountCents={summary.feeCents}
                hint="Cadence's cut. Already deducted from your earnings."
              />
              <MoneyCard
                label="Your net earnings"
                amountCents={summary.netCents}
                hint="What you keep — gross revenue minus the platform fee."
                emphasis
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <StatCard
                label="Buyers"
                value={audience.buyerCount}
                hint="People who paid. A team buying several seats counts once."
                emptyHint="Nobody has bought in this period."
              />
              <StatCard
                label="Enrolled students"
                value={audience.studentCount}
                hint={`Learners with access, seats included.${
                  audience.revenuePerStudentCents === null
                    ? ""
                    : ` ${formatMoney(
                        audience.revenuePerStudentCents
                      )} of revenue each.`
                }`}
                emptyHint="Nobody has enrolled in this period."
              />
              <StatCard
                label="Unanswered questions"
                value={questions.inRange}
                hint={
                  questions.older > 0
                    ? `Plus ${questions.older} from before this period.`
                    : "Students waiting on a reply."
                }
                // Quiet this period is only good news if the backlog is empty
                // too, so the older count keeps its place in the empty copy.
                emptyHint={
                  questions.older > 0
                    ? `None this period, but ${questions.older} still waiting from before.`
                    : "Nothing is waiting on you."
                }
                action={
                  questions.inRange + questions.older > 0 ? (
                    <Link
                      to="/instructor/questions"
                      className="mt-3 inline-block text-xs font-medium text-primary hover:underline"
                    >
                      Answer them
                    </Link>
                  ) : null
                }
              />
              <StatCard
                label="Course rating"
                value={ratings.average === null ? "—" : `${ratings.average} ★`}
                hint={`Across ${ratings.count} ${
                  ratings.count === 1 ? "rating" : "ratings"
                }.`}
                emptyHint="Nobody has rated your courses in this period."
              />
            </div>

            <Card>
              <CardContent className="p-6">
                <h2 className="mb-4 text-lg font-semibold">
                  Revenue over time
                </h2>
                {/* Keyed on the sales themselves, not on the points: a fixed
                    range always spans its whole window, so an instructor with
                    no sales would otherwise get a flat line along zero rather
                    than being told there is nothing there. */}
                {summary.purchaseCount === 0 ? (
                  <p className="py-12 text-center text-sm text-muted-foreground">
                    No sales in this period yet.
                  </p>
                ) : (
                  <RevenueChart series={series} />
                )}
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-6">
                <h2 className="text-lg font-semibold">Top buyers</h2>
                <p className="mb-4 text-sm text-muted-foreground">
                  Your ten biggest spenders in this period — the people worth
                  reaching out to.
                </p>
                <TopBuyers buyers={buyers} />
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="course" className="space-y-6">
            <Select
              value={selectedCourse ? String(selectedCourse.courseId) : "all"}
              onValueChange={(value) =>
                setParam("course", value === "all" ? null : value)
              }
            >
              <SelectTrigger aria-label="Course" className="w-72">
                <SelectValue>
                  {selectedCourse?.title ?? "All courses"}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All courses</SelectItem>
                {courseOptions.map((course) => (
                  <SelectItem
                    key={course.courseId}
                    value={String(course.courseId)}
                  >
                    {course.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {progress && funnel ? (
              progress.enrolledCount === 0 ? (
                <Card>
                  <CardContent className="py-12 text-center">
                    <p className="font-medium">Nobody is enrolled yet</p>
                    <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
                      Progress and drop-off appear as soon as the first student
                      joins {selectedCourse?.title}.
                    </p>
                  </CardContent>
                </Card>
              ) : (
                <>
                  <CourseProgress progress={progress} />

                  <Card>
                    <CardContent className="p-6">
                      <h2 className="text-lg font-semibold">Drop-off</h2>
                      <p className="mb-4 text-sm text-muted-foreground">
                        How many of the {funnel.enrolledCount} enrolled{" "}
                        {funnel.enrolledCount === 1 ? "student" : "students"}{" "}
                        got at least as far as each lesson, all time. The bars
                        only descend, so the biggest gap is where students quit
                        — the figure beside a lesson counts the ones who never
                        reached it, having stopped on the lesson above.
                      </p>
                      <DropOffFunnel funnel={funnel} />
                    </CardContent>
                  </Card>
                </>
              )
            ) : (
              <Card>
                <CardContent className="py-12 text-center">
                  <p className="font-medium">Pick a course</p>
                  <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
                    {courseOptions.length === 0
                      ? "There are no courses here to look into yet."
                      : "Choose one of your courses above to see how far students get and where they give up."}
                  </p>
                </CardContent>
              </Card>
            )}

            {/* Both panels sit outside the enrolment gate above: a quiz with
                nobody enrolled to sit it, and money arriving before anybody
                claims their seat, are things an instructor should still be
                told about rather than shown one "nobody is enrolled" card in
                place of. */}
            {quizzes && (
              <Card>
                <CardContent className="p-6">
                  <h2 className="text-lg font-semibold">Quiz results</h2>
                  <p className="mb-4 text-sm text-muted-foreground">
                    One result per student per quiz, counting their best attempt
                    — the same basis as the student roster. Retakes are not
                    counted separately, so a quiz people get on the second go
                    still reads as passed. Attempts made in this period only.
                  </p>
                  <QuizPassRates quizzes={quizzes} />
                </CardContent>
              </Card>
            )}

            {countries && (
              <Card>
                <CardContent className="p-6">
                  <h2 className="text-lg font-semibold">Revenue by country</h2>
                  <RevenueByCountry breakdown={countries} />
                </CardContent>
              </Card>
            )}

            <Card>
              <CardContent className="p-6">
                {revenueRows.length === 0 ? (
                  <p className="py-12 text-center text-sm text-muted-foreground">
                    No sales in this period yet.
                  </p>
                ) : (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left text-muted-foreground">
                        <th className="pb-2 font-medium">Course</th>
                        <th className="pb-2 text-right font-medium">Sales</th>
                        <th className="pb-2 text-right font-medium">Gross</th>
                        <th className="pb-2 text-right font-medium">
                          Fee ({PLATFORM_FEE_PERCENT}%)
                        </th>
                        <th className="pb-2 text-right font-medium">Net</th>
                      </tr>
                    </thead>
                    <tbody>
                      {revenueRows.map((course) => (
                        <tr key={course.courseId} className="border-b">
                          <td className="py-3 font-medium">{course.title}</td>
                          <td className="py-3 text-right tabular-nums">
                            {course.purchaseCount}
                          </td>
                          <td className="py-3 text-right tabular-nums">
                            {formatMoney(course.grossCents)}
                          </td>
                          <td className="py-3 text-right tabular-nums text-muted-foreground">
                            {formatMoney(course.feeCents)}
                          </td>
                          <td className="py-3 text-right font-medium tabular-nums">
                            {formatMoney(course.netCents)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}

export function HydrateFallback() {
  return (
    <div className="mx-auto max-w-5xl p-6 lg:p-8">
      <div className="mb-6 flex items-end justify-between gap-4">
        <div>
          <Skeleton className="mb-2 h-9 w-48" />
          <Skeleton className="h-4 w-72" />
        </div>
        <Skeleton className="h-9 w-40" />
      </div>
      <Skeleton className="mb-4 h-9 w-64" />
      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
      <Skeleton className="h-80 w-full" />
    </div>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let title = "Something went wrong";
  let message = "An unexpected error occurred while loading your analytics.";

  if (isRouteErrorResponse(error)) {
    if (error.status === 401) {
      title = "Sign in required";
      message =
        typeof error.data === "string"
          ? error.data
          : "Please select a user from the DevUI panel.";
    } else if (error.status === 403) {
      title = "Not allowed";
      message =
        typeof error.data === "string"
          ? error.data
          : "You don't have access to this page.";
    } else {
      title = `Error ${error.status}`;
      message = typeof error.data === "string" ? error.data : error.statusText;
    }
  }

  return (
    <div className="flex min-h-[50vh] items-center justify-center p-6">
      <div className="text-center">
        <AlertTriangle className="mx-auto mb-4 size-12 text-muted-foreground" />
        <h1 className="mb-2 text-2xl font-bold">{title}</h1>
        <p className="mb-6 text-muted-foreground">{message}</p>
        <Link to="/courses">
          <Button>Browse Courses</Button>
        </Link>
      </div>
    </div>
  );
}
