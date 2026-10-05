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
import { AlertTriangle, BarChart3, BookOpen } from "lucide-react";

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

function OverviewTab({ data }: { data: LoaderData }) {
  return (
    <div className="space-y-6">
      <RevenueFigures revenue={data.overview.revenue} />
      <RevenueChart points={data.overview.revenueOverTime} range={data.range} />
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
