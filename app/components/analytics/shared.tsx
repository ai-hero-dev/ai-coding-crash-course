import { Link } from "react-router";
import { BookOpen } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Card, CardContent } from "~/components/ui/card";

// ─── Analytics: shared pieces ───
// Small building blocks used by both tabs of the analytics page.

/** The empty state inside a panel card. */
export function PanelEmpty({ title, body }: { title: string; body: string }) {
  return (
    <div className="py-8 text-center">
      <p className="font-medium">{title}</p>
      <p className="mt-1 text-sm text-muted-foreground">{body}</p>
    </div>
  );
}

export const tableHeadClass =
  "px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground";

export function ProgressBar({ percent }: { percent: number }) {
  return (
    <div className="h-2 w-full rounded-full bg-muted">
      <div
        className="h-2 rounded-full bg-primary transition-all"
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}

/** Shown in place of both tabs when no course in scope is published. */
export function NoPublishedCourses({
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
