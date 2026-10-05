import { Link, isRouteErrorResponse } from "react-router";
import type { Route } from "./+types/instructor.analytics";
import { requireInstructorOrAdmin } from "~/lib/access.server";
import { UserRole } from "~/db/schema";
import { getUsersByRole } from "~/services/userService";
import {
  getAnalyticsCourses,
  getCourseDetail,
  getOverview,
} from "~/services/analyticsService";
import {
  parseAnalyticsRange,
  parseAnalyticsTab,
  parseIdParam,
} from "~/lib/analytics";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import {
  InstructorSelect,
  RangeSelect,
  useSetParam,
} from "~/components/analytics/controls";
import { OverviewTab } from "~/components/analytics/overview-tab";
import { CourseDetailTab } from "~/components/analytics/course-detail-tab";
import { NoPublishedCourses } from "~/components/analytics/shared";
import { AlertTriangle } from "lucide-react";

// ─── Instructor Analytics ───
// One page that answers "how is my teaching business doing". All page state
// (tab, range, instructor, course) lives in the URL and is read here in the
// loader; all arithmetic lives in analyticsService. To add a panel: extend
// getOverview (or getCourseDetail) and render its result in the matching tab
// under app/components/analytics/.

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
    overview: getOverview(instructorId, range),
    courseDetail:
      tab === "course" && selectedCourse
        ? getCourseDetail(selectedCourse.id, range)
        : null,
  };
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
            <OverviewTab overview={data.overview} range={data.range} />
          </TabsContent>
          <TabsContent value="course">
            <CourseDetailTab
              courses={data.courses}
              selectedCourse={data.selectedCourse}
              courseDetail={data.courseDetail}
              range={data.range}
            />
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

/**
 * The page frame (header, instructor picker, range, tabs) with full-width
 * blocks below. The fallback cannot know the tab, so the body has no
 * tab-specific grid: both tabs start with full-width rows, and nothing jumps.
 */
export function HydrateFallback() {
  return (
    <div className="mx-auto max-w-7xl p-6 lg:p-8">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <Skeleton className="h-9 w-48" />
          <Skeleton className="mt-1 h-6 w-72" />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {/* Admin instructor picker (InstructorSelect, w-56). */}
          <Skeleton className="h-9 w-56" />
          {/* Range picker (RangeSelect, w-40). */}
          <Skeleton className="h-9 w-40" />
        </div>
      </div>
      {/* Tab list: Overview, Course detail. */}
      <Skeleton className="mb-4 h-9 w-56" />
      <div className="space-y-6">
        <Skeleton className="h-36 w-full" />
        <Skeleton className="h-96 w-full" />
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
