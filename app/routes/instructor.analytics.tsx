import { Link, isRouteErrorResponse, useSearchParams } from "react-router";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import type { Route } from "./+types/instructor.analytics";
import { requireInstructorOrAdmin } from "~/lib/access.server";
import {
  getRevenueByCourse,
  getRevenueOverTime,
  getRevenueSummary,
  hasPublishedCourses,
  listCourseOwners,
  type RevenueSeries,
} from "~/services/analyticsService";
import {
  ANALYTICS_RANGES,
  PLATFORM_FEE_PERCENT,
  formatBucket,
  formatMoney,
  parseAnalyticsRange,
} from "~/lib/analytics";
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

export async function loader({ request, url }: Route.LoaderArgs) {
  const { userId, isAdmin } = await requireInstructorOrAdmin(request);

  const range = parseAnalyticsRange(url.searchParams.get("range"));
  const tab: AnalyticsTab =
    url.searchParams.get("tab") === "course" ? "course" : "overview";
  const selectedCourseId = parseId(url.searchParams.get("course"));

  // Instructors are pinned to their own figures; only an admin may look
  // elsewhere, and null means "every instructor".
  const instructorId = isAdmin
    ? parseId(url.searchParams.get("instructor"))
    : userId;

  return {
    tab,
    range,
    isAdmin,
    instructorId,
    selectedCourseId,
    summary: getRevenueSummary(instructorId, range),
    series: getRevenueOverTime(instructorId, range),
    courses: getRevenueByCourse(instructorId, range),
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
    instructors,
    unpublished,
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
    courses.find((course) => course.courseId === selectedCourseId) ?? null;

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
                {courses.map((course) => (
                  <SelectItem
                    key={course.courseId}
                    value={String(course.courseId)}
                  >
                    {course.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Card>
              <CardContent className="p-6">
                {courses.length === 0 ? (
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
                      {(selectedCourse ? [selectedCourse] : courses).map(
                        (course) => (
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
                        )
                      )}
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
