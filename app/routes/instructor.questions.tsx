import { useEffect, useState } from "react";
import { Link, data, isRouteErrorResponse, useFetcher } from "react-router";
import { toast } from "sonner";
import { z } from "zod";
import type { Route } from "./+types/instructor.questions";
import {
  requireInstructorOrAdmin,
  requireStaff,
} from "~/lib/access.server";
import {
  getUnansweredQuestions,
  getCommentById,
  getCourseForLesson,
  createComment,
} from "~/services/commentService";
import { renderComment } from "~/lib/comment-markdown.server";
import { Button } from "~/components/ui/button";
import { Card, CardContent } from "~/components/ui/card";
import { Skeleton } from "~/components/ui/skeleton";
import { Textarea } from "~/components/ui/textarea";
import { UserAvatar } from "~/components/user-avatar";
import { AlertTriangle, CheckCircle2, ExternalLink } from "lucide-react";
import { cn, daysSince, formatRelativeTime } from "~/lib/utils";
import { MAX_COMMENT_LENGTH } from "~/lib/comments";
import { parseFormData } from "~/lib/validation";

// ─── Unanswered Questions Queue ───
// The instructor-side half of lesson comments. Without it, a question posted on
// lesson 34 of module 6 is invisible unless someone happens to revisit that
// lesson — which is how a Q&A feature quietly becomes a list of things nobody
// ever answered.
//
// "Unanswered" is derived, not stored: see commentService.getUnansweredQuestions.

// A question sitting this long without an answer gets called out visually.
const STALE_AFTER_DAYS = 3;

const replySchema = z.object({
  intent: z.literal("reply"),
  commentId: z.coerce.number().int(),
  body: z.string(),
});

export function meta() {
  return [{ title: "Unanswered Questions — Cadence" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const { userId, isAdmin } = await requireInstructorOrAdmin(request);

  // Admins span every course; instructors see only the courses they own.
  const questions = getUnansweredQuestions(isAdmin ? null : userId);

  const rendered = await Promise.all(
    questions.map(async (question) => ({
      ...question,
      bodyHtml: await renderComment(question.body),
    }))
  );

  return { questions: rendered, isAdmin };
}

export async function action({ request }: Route.ActionArgs) {
  const formData = await request.formData();
  const parsed = parseFormData(formData, replySchema);

  if (!parsed.success) {
    return { ok: false, error: "Enter a reply before posting." };
  }

  const question = getCommentById(parsed.data.commentId);
  if (!question) {
    throw data("Question not found", { status: 404 });
  }

  const course = getCourseForLesson(question.lessonId);
  if (!course) {
    throw data("Course not found", { status: 404 });
  }

  // Answering as the course's voice — so it must be the course's own
  // instructor, or an admin.
  const access = await requireStaff(request, course.courseId);

  try {
    createComment(
      access.userId!,
      question.lessonId,
      question.id,
      parsed.data.body
    );
  } catch (error) {
    if (error instanceof Error) {
      return { ok: false, error: error.message };
    }
    throw error;
  }

  return { ok: true };
}

type Question = Awaited<ReturnType<typeof loader>>["questions"][number];

function QuestionCard({ question }: { question: Question }) {
  const fetcher = useFetcher<{ ok?: boolean; error?: string }>();
  const [body, setBody] = useState("");
  const waitingDays = daysSince(question.createdAt);
  const stale = waitingDays >= STALE_AFTER_DAYS;
  const submitting = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;

    if (fetcher.data.error) {
      toast.error(fetcher.data.error);
    } else if (fetcher.data.ok) {
      setBody("");
      toast.success("Reply posted.");
    }
  }, [fetcher.state, fetcher.data]);

  return (
    <Card>
      <CardContent className="p-6">
        <div className="mb-3 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <span className="font-medium text-foreground">
            {question.courseTitle}
          </span>
          <span>/</span>
          <span>{question.lessonTitle}</span>
          <Link
            to={`/courses/${question.courseSlug}/lessons/${question.lessonId}`}
            className="inline-flex items-center gap-1 hover:text-foreground"
          >
            <ExternalLink className="size-3.5" />
            Open lesson
          </Link>

          <span
            className={cn(
              "ml-auto rounded-full px-2 py-0.5 text-xs font-medium",
              stale
                ? "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300"
                : "bg-muted text-muted-foreground"
            )}
            suppressHydrationWarning
          >
            {waitingDays === 0
              ? "Waiting today"
              : `Waiting ${waitingDays} day${waitingDays === 1 ? "" : "s"}`}
          </span>
        </div>

        <div className="flex items-start gap-3">
          <UserAvatar
            name={question.authorName}
            avatarUrl={question.authorAvatarUrl}
            className="size-8 shrink-0"
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">{question.authorName}</span>
              <span
                className="text-xs text-muted-foreground"
                suppressHydrationWarning
              >
                {formatRelativeTime(question.createdAt)}
              </span>
            </div>
            <div
              className="prose prose-sm prose-neutral dark:prose-invert mt-1 max-w-none"
              dangerouslySetInnerHTML={{ __html: question.bodyHtml }}
            />
          </div>
        </div>

        <fetcher.Form method="post" className="mt-4 space-y-2">
          <input type="hidden" name="intent" value="reply" />
          <input type="hidden" name="commentId" value={question.id} />

          <Textarea
            name="body"
            value={body}
            onChange={(event) => setBody(event.target.value)}
            placeholder="Answer this question..."
            rows={3}
            aria-label={`Reply to ${question.authorName}`}
          />

          <div className="flex items-center gap-3">
            <Button
              type="submit"
              size="sm"
              disabled={
                submitting ||
                body.trim().length === 0 ||
                body.length > MAX_COMMENT_LENGTH
              }
            >
              {submitting ? "Posting..." : "Post reply"}
            </Button>
            <span
              className={cn(
                "ml-auto text-xs",
                body.length > MAX_COMMENT_LENGTH
                  ? "text-destructive"
                  : "text-muted-foreground"
              )}
            >
              {body.length} / {MAX_COMMENT_LENGTH}
            </span>
          </div>
        </fetcher.Form>
      </CardContent>
    </Card>
  );
}

export default function InstructorQuestions({
  loaderData,
}: Route.ComponentProps) {
  const { questions, isAdmin } = loaderData;

  return (
    <div className="mx-auto max-w-4xl p-6 lg:p-8">
      <nav className="mb-6 text-sm text-muted-foreground">
        {/* /instructor is instructor-only, so admins go back to their own list. */}
        <Link
          to={isAdmin ? "/admin/courses" : "/instructor"}
          className="hover:text-foreground"
        >
          {isAdmin ? "Manage Courses" : "My Courses"}
        </Link>
        <span className="mx-2">/</span>
        <span className="text-foreground">Questions</span>
      </nav>

      <div className="mb-6">
        <h1 className="text-3xl font-bold">Unanswered Questions</h1>
        <p className="mt-1 text-muted-foreground">
          {isAdmin
            ? "Questions across every course that no instructor or admin has replied to yet."
            : "Questions on your courses that you haven't replied to yet."}{" "}
          Replying here marks them answered.
        </p>
      </div>

      {questions.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <CheckCircle2 className="mx-auto mb-4 size-12 text-green-600" />
            <p className="font-medium">You&apos;re all caught up</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Every question on your courses has an answer.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {questions.map((question) => (
            <QuestionCard key={question.id} question={question} />
          ))}
        </div>
      )}
    </div>
  );
}

export function HydrateFallback() {
  return (
    <div className="mx-auto max-w-4xl p-6 lg:p-8">
      <Skeleton className="mb-6 h-4 w-40" />
      <Skeleton className="mb-2 h-9 w-72" />
      <Skeleton className="mb-6 h-4 w-96" />
      <div className="space-y-4">
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    </div>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let title = "Something went wrong";
  let message = "An unexpected error occurred while loading your questions.";

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
        <Link to="/instructor">
          <Button>My Courses</Button>
        </Link>
      </div>
    </div>
  );
}
