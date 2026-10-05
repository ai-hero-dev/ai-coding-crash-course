import { Link, isRouteErrorResponse, useSearchParams } from "react-router";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import type { Route } from "./+types/instructor.analytics";
import { requireInstructorOrAdmin } from "~/lib/access.server";
import { UserRole } from "~/db/schema";
import { getUsersByRole } from "~/services/userService";
import {
  getAnalyticsCourses,
  getOverview,
  type RevenuePoint,
} from "~/services/analyticsService";
import {
  ANALYTICS_RANGES,
  ANALYTICS_RANGE_LABELS,
  PLATFORM_FEE_RATE,
  formatCents,
  parseAnalyticsRange,
  parseAnalyticsTab,
  parseIdParam,
  type AnalyticsRange,
} from "~/lib/analytics";
import { Button } from "~/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { AlertTriangle, BarChart3, BookOpen, Star } from "lucide-react";

// ─── Instructor Analytics ───
// One page that answers "how is my teaching business doing". All page state
// (tab, range, instructor, course) lives in the URL and is read here in the
// loader; all arithmetic lives in analyticsService. To add a panel: extend
// getOverview (or add a course-detail function) and render its result here.

// Admin picker value meaning "every instructor". Radix Select forbids "".
const ALL_INSTRUCTORS = "all";

export function meta() {
  return [{ title: "Analytics — Cadence" }];
}

export async function loader({ request, url }: Route.LoaderArgs) {
  const { userId, isAdmin } = await requireInstructorOrAdmin(request);
  const params = url.searchParams;

  const tab = parseAnalyticsTab(params.get("tab"));
  const range = parseAnalyticsRange(params.get("range"));

  const instructors = isAdmin
    ? getUsersByRole(UserRole.Instructor).map(({ id, name }) => ({ id, name }))
    : [];

  // Instructors always see their own figures, whatever the URL says. Admins
  // see the picked instructor, or the whole platform (null) when none is.
  const pickedId = parseIdParam(params.get("instructor"));
  const instructorId = isAdmin
    ? (instructors.find((instructor) => instructor.id === pickedId)?.id ?? null)
    : userId;

  const courses = getAnalyticsCourses(instructorId);
  const pickedCourseId = parseIdParam(params.get("course"));
  const selectedCourse =
    courses.find((course) => course.id === pickedCourseId) ??
    courses[0] ??
    null;

  return {
    isAdmin,
    tab,
    range,
    instructors,
    instructorId,
    courses,
    selectedCourse,
    overview: getOverview({ instructorId, range }),
  };
}

type LoaderData = Awaited<ReturnType<typeof loader>>;

/** Sets one search param, keeping the others, so every view is a URL. */
function useSetParam() {
  const [, setSearchParams] = useSearchParams();
  return (key: string, value: string) =>
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set(key, value);
        return next;
      },
      { preventScrollReset: true }
    );
}

// ─── Controls ───

function RangeSelect({ range }: { range: AnalyticsRange }) {
  const setParam = useSetParam();
  return (
    <Select value={range} onValueChange={(value) => setParam("range", value)}>
      <SelectTrigger className="w-40" aria-label="Time range">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {ANALYTICS_RANGES.map((option) => (
          <SelectItem key={option} value={option}>
            {ANALYTICS_RANGE_LABELS[option]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function InstructorSelect({
  instructors,
  instructorId,
}: {
  instructors: LoaderData["instructors"];
  instructorId: number | null;
}) {
  const setParam = useSetParam();
  return (
    <Select
      value={instructorId === null ? ALL_INSTRUCTORS : String(instructorId)}
      onValueChange={(value) => setParam("instructor", value)}
    >
      <SelectTrigger className="w-56" aria-label="Instructor">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL_INSTRUCTORS}>All instructors</SelectItem>
        {instructors.map((instructor) => (
          <SelectItem key={instructor.id} value={String(instructor.id)}>
            {instructor.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function CourseSelect({
  courses,
  selectedCourse,
}: {
  courses: LoaderData["courses"];
  selectedCourse: LoaderData["selectedCourse"];
}) {
  const setParam = useSetParam();
  if (!selectedCourse) return null;
  return (
    <Select
      value={String(selectedCourse.id)}
      onValueChange={(value) => setParam("course", value)}
    >
      <SelectTrigger className="w-72" aria-label="Course">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {courses.map((course) => (
          <SelectItem key={course.id} value={String(course.id)}>
            {course.title}
            {course.status !== "published" && ` (${course.status})`}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// ─── Overview panels ───

function MoneyFigure({
  label,
  description,
  cents,
}: {
  label: string;
  description: string;
  cents: number;
}) {
  return (
    <Card>
      <CardHeader>
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-3xl tabular-nums">
          {formatCents(cents)}
        </CardTitle>
      </CardHeader>
      <CardContent className="text-xs text-muted-foreground">
        {description}
      </CardContent>
    </Card>
  );
}

function RevenueFigures({
  revenue,
}: {
  revenue: LoaderData["overview"]["revenue"];
}) {
  const feePercent = Math.round(PLATFORM_FEE_RATE * 100);
  return (
    <div className="grid gap-4 md:grid-cols-3">
      <MoneyFigure
        label="Gross revenue"
        description="Total paid by buyers, before any fee."
        cents={revenue.grossCents}
      />
      <MoneyFigure
        label={`Platform fee (${feePercent}%)`}
        description="The platform's cut of gross revenue."
        cents={revenue.feeCents}
      />
      <MoneyFigure
        label="Net earnings"
        description="Gross revenue minus the platform fee. Not a payout."
        cents={revenue.netCents}
      />
    </div>
  );
}

const revenueChartConfig = {
  grossCents: { label: "Gross revenue", color: "var(--chart-1)" },
} satisfies ChartConfig;

/** "2026-06-14" → "Jun 14"; "2026-06" → "Jun 2026". */
function formatPeriod(period: string): string {
  const isMonth = period.length === 7;
  const date = new Date(
    isMonth ? `${period}-01T00:00:00Z` : `${period}T00:00:00Z`
  );
  return date.toLocaleDateString(
    "en-US",
    isMonth
      ? { month: "short", year: "numeric", timeZone: "UTC" }
      : { month: "short", day: "numeric", timeZone: "UTC" }
  );
}

function RevenueChart({
  points,
  range,
}: {
  points: RevenuePoint[];
  range: AnalyticsRange;
}) {
  const hasSales = points.some((point) => point.grossCents > 0);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Revenue over time</CardTitle>
        <CardDescription>
          Gross revenue per {range === "all" ? "month" : "day"},{" "}
          {ANALYTICS_RANGE_LABELS[range].toLowerCase()}.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {hasSales ? (
          <ChartContainer config={revenueChartConfig} className="h-72 w-full">
            <BarChart data={points} margin={{ left: 8, right: 8 }}>
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="period"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                minTickGap={24}
                tickFormatter={formatPeriod}
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                width={72}
                tickFormatter={(cents: number) => formatCents(cents)}
              />
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    labelFormatter={(_, payload) =>
                      formatPeriod(String(payload[0]?.payload?.period ?? ""))
                    }
                    formatter={(value) => (
                      <div className="flex w-full justify-between gap-4">
                        <span className="text-muted-foreground">
                          Gross revenue
                        </span>
                        <span className="font-mono font-medium tabular-nums">
                          {formatCents(Number(value))}
                        </span>
                      </div>
                    )}
                  />
                }
              />
              <Bar
                dataKey="grossCents"
                fill="var(--color-grossCents)"
                radius={[4, 4, 0, 0]}
              />
            </BarChart>
          </ChartContainer>
        ) : (
          <div className="flex h-72 flex-col items-center justify-center text-center">
            <BarChart3 className="mb-3 size-10 text-muted-foreground/50" />
            <p className="font-medium">No sales in this period</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Sales appear here as soon as someone buys a course. Try a longer
              range.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function CountFigure({
  label,
  value,
  description,
}: {
  label: string;
  value: string;
  description: string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-3xl tabular-nums">{value}</CardTitle>
      </CardHeader>
      <CardContent className="text-xs text-muted-foreground">
        {description}
      </CardContent>
    </Card>
  );
}

function AudienceFigures({
  audience,
  range,
}: {
  audience: LoaderData["overview"]["audience"];
  range: AnalyticsRange;
}) {
  const period = ANALYTICS_RANGE_LABELS[range].toLowerCase();
  return (
    <div className="grid gap-4 md:grid-cols-3">
      <CountFigure
        label="Buyers"
        value={String(audience.buyers)}
        description={
          audience.buyers === 0
            ? `No one bought a course ${period}.`
            : `Distinct people who paid, ${period}. A team buyer counts once.`
        }
      />
      <CountFigure
        label="Students"
        value={String(audience.students)}
        description={
          audience.students === 0
            ? `No one enrolled ${period}.`
            : `Distinct people who enrolled, ${period}, by purchase or team seat.`
        }
      />
      <CountFigure
        label="Revenue per student"
        value={formatCents(audience.revenuePerStudentCents)}
        description={
          audience.students === 0
            ? "Shown once students enrol."
            : "What each enrolled student brought in. Team seats count at their share of the team purchase."
        }
      />
    </div>
  );
}

function PanelEmpty({ title, body }: { title: string; body: string }) {
  return (
    <div className="py-8 text-center">
      <p className="font-medium">{title}</p>
      <p className="mt-1 text-sm text-muted-foreground">{body}</p>
    </div>
  );
}

const tableHeadClass =
  "px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground";

function TopBuyers({
  buyers,
  range,
}: {
  buyers: LoaderData["overview"]["topBuyers"];
  range: AnalyticsRange;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Top buyers</CardTitle>
        <CardDescription>
          The ten biggest spenders across your courses,{" "}
          {ANALYTICS_RANGE_LABELS[range].toLowerCase()}. Worth a personal
          message.
        </CardDescription>
      </CardHeader>
      <CardContent className={buyers.length === 0 ? undefined : "p-0"}>
        {buyers.length === 0 ? (
          <PanelEmpty
            title="No buyers in this period"
            body="Your biggest customers appear here once people buy. Try a longer range."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-y border-border bg-muted/50">
                  <th className={tableHeadClass}>#</th>
                  <th className={tableHeadClass}>Buyer</th>
                  <th className={tableHeadClass}>Seats</th>
                  <th className={`${tableHeadClass} text-right`}>
                    Total spend
                  </th>
                </tr>
              </thead>
              <tbody>
                {buyers.map((buyer, index) => (
                  <tr
                    key={buyer.userId}
                    className="border-b border-border last:border-0"
                  >
                    <td className="px-4 py-3 text-sm text-muted-foreground tabular-nums">
                      {index + 1}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{buyer.name}</span>
                        {buyer.isTeamBuyer && (
                          <span className="inline-flex items-center rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-800 dark:bg-blue-900/30 dark:text-blue-400">
                            Team
                          </span>
                        )}
                        {!buyer.enrolled && (
                          <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                            Not enrolled
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {buyer.email}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-sm">
                      {buyer.isTeamBuyer ? (
                        <>
                          Bought {buyer.seats}
                          {buyer.unredeemedSeats > 0 ? (
                            <span className="text-amber-700 dark:text-amber-400">
                              , {buyer.unredeemedSeats} unused
                            </span>
                          ) : (
                            ", all used"
                          )}
                        </>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right font-medium tabular-nums">
                      {formatCents(buyer.totalSpentCents)}
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

function ActionFigures({
  seats,
  unansweredQuestions,
  range,
}: {
  seats: LoaderData["overview"]["seats"];
  unansweredQuestions: number;
  range: AnalyticsRange;
}) {
  const period = ANALYTICS_RANGE_LABELS[range].toLowerCase();
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card>
        <CardHeader>
          <CardDescription>Unanswered questions</CardDescription>
          <CardTitle className="text-3xl tabular-nums">
            {unansweredQuestions}
          </CardTitle>
        </CardHeader>
        <CardContent className="text-xs text-muted-foreground">
          {unansweredQuestions === 0 ? (
            `No student is waiting on an answer to a question asked ${period}.`
          ) : (
            <>
              Questions asked {period} that no one on staff has answered.{" "}
              <Link
                to="/instructor/questions"
                className="font-medium text-foreground underline underline-offset-4"
              >
                Answer them
              </Link>
            </>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardDescription>Unredeemed team seats</CardDescription>
          <CardTitle className="text-3xl tabular-nums">
            {seats.unredeemed}
            {seats.sold > 0 && (
              <span className="text-base font-normal text-muted-foreground">
                {" "}
                of {seats.sold}
              </span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="text-xs text-muted-foreground">
          {seats.sold === 0
            ? `No team seats were sold ${period}.`
            : `Seats bought by teams ${period} that no one has claimed. Chase the team buyers above.`}
        </CardContent>
      </Card>
    </div>
  );
}

function Ratings({
  ratings,
  range,
}: {
  ratings: LoaderData["overview"]["ratings"];
  range: AnalyticsRange;
}) {
  const period = ANALYTICS_RANGE_LABELS[range].toLowerCase();
  return (
    <Card>
      <CardHeader>
        <CardTitle>Course ratings</CardTitle>
        <CardDescription>
          {ratings.average === null
            ? `Ratings given ${period}.`
            : `${ratings.average} out of 5 from ${ratings.count} rating${ratings.count === 1 ? "" : "s"} given ${period}.`}
        </CardDescription>
      </CardHeader>
      <CardContent className={ratings.count === 0 ? undefined : "p-0"}>
        {ratings.count === 0 ? (
          <PanelEmpty
            title="No ratings in this period"
            body="Students rate a course from its page. Ratings appear here as they come in."
          />
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-y border-border bg-muted/50">
                <th className={tableHeadClass}>Course</th>
                <th className={`${tableHeadClass} text-right`}>Average</th>
                <th className={`${tableHeadClass} text-right`}>Ratings</th>
              </tr>
            </thead>
            <tbody>
              {ratings.courses.map((course) => (
                <tr
                  key={course.courseId}
                  className="border-b border-border last:border-0"
                >
                  <td className="px-4 py-3 font-medium">{course.title}</td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {course.average === null ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <span className="inline-flex items-center gap-1">
                        <Star className="size-3.5 fill-amber-400 text-amber-400" />
                        {course.average.toFixed(1)}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                    {course.count}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  );
}

function OverviewTab({ data }: { data: LoaderData }) {
  const { overview, range } = data;
  return (
    <div className="space-y-6">
      <RevenueFigures revenue={overview.revenue} />
      <RevenueChart points={overview.revenueOverTime} range={range} />
      <AudienceFigures audience={overview.audience} range={range} />
      <TopBuyers buyers={overview.topBuyers} range={range} />
      <ActionFigures
        seats={overview.seats}
        unansweredQuestions={overview.unansweredQuestions}
        range={range}
      />
      <Ratings ratings={overview.ratings} range={range} />
    </div>
  );
}

// ─── Course detail ───

function CourseDetailTab({ data }: { data: LoaderData }) {
  if (!data.selectedCourse) {
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
      <CourseSelect
        courses={data.courses}
        selectedCourse={data.selectedCourse}
      />
      <Card>
        <CardContent className="py-12 text-center text-sm text-muted-foreground">
          Lesson drop-off, student progress, quiz pass rates and revenue by
          country for {data.selectedCourse.title} will appear here.
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Page ───

function NoPublishedCourses({
  isAdmin,
  platformWide,
}: {
  isAdmin: boolean;
  platformWide: boolean;
}) {
  return (
    <Card>
      <CardContent className="py-12 text-center">
        <BookOpen className="mx-auto mb-4 size-12 text-muted-foreground/50" />
        <p className="font-medium">
          {isAdmin
            ? platformWide
              ? "There are no published courses yet"
              : "This instructor has no published courses"
            : "Publish your first course"}
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          {isAdmin
            ? "Analytics appear once a course is published."
            : "Your revenue, students and course analytics appear here once a course is published."}
        </p>
        {!isAdmin && (
          <Link to="/instructor">
            <Button className="mt-6">Go to My Courses</Button>
          </Link>
        )}
      </CardContent>
    </Card>
  );
}

export default function InstructorAnalytics({
  loaderData,
}: Route.ComponentProps) {
  const data = loaderData;
  const setParam = useSetParam();

  return (
    <div className="mx-auto max-w-7xl p-6 lg:p-8">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">Analytics</h1>
          <p className="mt-1 text-muted-foreground">
            {data.isAdmin && data.instructorId === null
              ? "How the whole platform is doing."
              : "How your teaching business is doing."}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {data.isAdmin && (
            <InstructorSelect
              instructors={data.instructors}
              instructorId={data.instructorId}
            />
          )}
          <RangeSelect range={data.range} />
        </div>
      </div>

      {data.overview.hasPublishedCourse ? (
        <Tabs
          value={data.tab}
          onValueChange={(value) => setParam("tab", value)}
        >
          <TabsList className="mb-4">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="course">Course detail</TabsTrigger>
          </TabsList>
          <TabsContent value="overview">
            <OverviewTab data={data} />
          </TabsContent>
          <TabsContent value="course">
            <CourseDetailTab data={data} />
          </TabsContent>
        </Tabs>
      ) : (
        <NoPublishedCourses
          isAdmin={data.isAdmin}
          platformWide={data.instructorId === null}
        />
      )}
    </div>
  );
}

export function HydrateFallback() {
  return (
    <div className="mx-auto max-w-7xl p-6 lg:p-8">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <Skeleton className="mb-2 h-9 w-48" />
          <Skeleton className="h-4 w-72" />
        </div>
        <Skeleton className="h-9 w-40" />
      </div>
      <Skeleton className="mb-4 h-9 w-56" />
      <div className="space-y-6">
        <div className="grid gap-4 md:grid-cols-3">
          <Skeleton className="h-36 w-full" />
          <Skeleton className="h-36 w-full" />
          <Skeleton className="h-36 w-full" />
        </div>
        <Skeleton className="h-96 w-full" />
        <div className="grid gap-4 md:grid-cols-3">
          <Skeleton className="h-36 w-full" />
          <Skeleton className="h-36 w-full" />
          <Skeleton className="h-36 w-full" />
        </div>
        <Skeleton className="h-96 w-full" />
      </div>
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
