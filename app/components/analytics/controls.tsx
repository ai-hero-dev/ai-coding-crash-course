import { useSearchParams } from "react-router";
import {
  ANALYTICS_RANGES,
  ANALYTICS_RANGE_LABELS,
  type AnalyticsRange,
} from "~/lib/analytics";
import type { AnalyticsCourse } from "~/services/analyticsService";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";

// ─── Analytics: page controls ───
// All page state (tab, range, instructor, course) lives in the URL. These
// controls only write search params; the route loader reads them.

// Admin picker value meaning "every instructor". Radix Select forbids "".
const ALL_INSTRUCTORS = "all";

/** Sets one search param, keeping the others, so every view is a URL. */
export function useSetParam() {
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

export function RangeSelect({ range }: { range: AnalyticsRange }) {
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

export function InstructorSelect({
  instructors,
  instructorId,
}: {
  instructors: { id: number; name: string }[];
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

export function CourseSelect({
  courses,
  selectedCourse,
}: {
  courses: AnalyticsCourse[];
  selectedCourse: AnalyticsCourse | null;
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
