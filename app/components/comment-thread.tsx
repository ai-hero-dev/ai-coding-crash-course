import { useEffect, useState } from "react";
import { useFetcher } from "react-router";
import { toast } from "sonner";
import { MessageSquare, Pencil, Reply, Trash2 } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Card, CardContent } from "~/components/ui/card";
import { Textarea } from "~/components/ui/textarea";
import { UserAvatar } from "~/components/user-avatar";
import { cn, formatRelativeTime } from "~/lib/utils";
import { MAX_COMMENT_LENGTH } from "~/lib/comments";

// Bodies arrive pre-rendered from the server (renderComment), because comments
// are untrusted markdown and the sanitising renderer is server-only.
export type RenderedComment = {
  id: number;
  /** Raw markdown — only used to populate the edit box. */
  body: string;
  bodyHtml: string;
  createdAt: string;
  editedAt: string | null;
  deleted: boolean;
  author: {
    id: number;
    name: string;
    avatarUrl: string | null;
    isInstructor: boolean;
    isAdmin: boolean;
  };
  replies: RenderedComment[];
};

function AuthorBadge({ label }: { label: string }) {
  return (
    <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
      {label}
    </span>
  );
}

function CommentForm({
  intent,
  parentId,
  commentId,
  defaultValue,
  placeholder,
  submitLabel,
  autoFocus,
  onDone,
}: {
  intent: "create-comment" | "edit-comment";
  parentId?: number;
  commentId?: number;
  defaultValue?: string;
  placeholder: string;
  submitLabel: string;
  autoFocus?: boolean;
  onDone?: () => void;
}) {
  const fetcher = useFetcher<{ ok?: boolean; error?: string }>();
  const [body, setBody] = useState(defaultValue ?? "");
  const submitting = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;

    if (fetcher.data.error) {
      toast.error(fetcher.data.error);
      return;
    }

    if (fetcher.data.ok) {
      if (intent === "create-comment") setBody("");
      onDone?.();
    }
    // onDone is recreated each render by callers; depending on it would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.state, fetcher.data, intent]);

  const tooLong = body.length > MAX_COMMENT_LENGTH;
  const empty = body.trim().length === 0;

  return (
    <fetcher.Form method="post" className="space-y-2">
      <input type="hidden" name="intent" value={intent} />
      {parentId !== undefined && (
        <input type="hidden" name="parentId" value={parentId} />
      )}
      {commentId !== undefined && (
        <input type="hidden" name="commentId" value={commentId} />
      )}

      <Textarea
        name="body"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder={placeholder}
        rows={4}
        autoFocus={autoFocus}
        aria-label={placeholder}
      />

      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" disabled={submitting || empty || tooLong}>
          {submitting ? "Posting..." : submitLabel}
        </Button>

        {onDone && (
          <Button type="button" variant="ghost" size="sm" onClick={onDone}>
            Cancel
          </Button>
        )}

        <span
          className={cn(
            "ml-auto text-xs",
            tooLong ? "text-destructive" : "text-muted-foreground"
          )}
        >
          {body.length} / {MAX_COMMENT_LENGTH}
        </span>
      </div>

      <p className="text-xs text-muted-foreground">
        Markdown supported. Use ``` for code blocks.
      </p>
    </fetcher.Form>
  );
}

function CommentActions({
  comment,
  canEdit,
  canDelete,
  canReply,
  onEdit,
  onReply,
}: {
  comment: RenderedComment;
  canEdit: boolean;
  canDelete: boolean;
  canReply: boolean;
  onEdit: () => void;
  onReply: () => void;
}) {
  const deleteFetcher = useFetcher<{ ok?: boolean; error?: string }>();

  useEffect(() => {
    if (deleteFetcher.data?.error) toast.error(deleteFetcher.data.error);
  }, [deleteFetcher.data]);

  if (!canEdit && !canDelete && !canReply) return null;

  return (
    <div className="mt-2 flex items-center gap-1">
      {canReply && (
        <Button variant="ghost" size="sm" onClick={onReply}>
          <Reply className="mr-1 size-3.5" />
          Reply
        </Button>
      )}

      {canEdit && (
        <Button variant="ghost" size="sm" onClick={onEdit}>
          <Pencil className="mr-1 size-3.5" />
          Edit
        </Button>
      )}

      {canDelete && (
        <deleteFetcher.Form
          method="post"
          onSubmit={(event) => {
            if (!confirm("Delete this comment?")) event.preventDefault();
          }}
        >
          <input type="hidden" name="intent" value="delete-comment" />
          <input type="hidden" name="commentId" value={comment.id} />
          <Button
            type="submit"
            variant="ghost"
            size="sm"
            disabled={deleteFetcher.state !== "idle"}
          >
            <Trash2 className="mr-1 size-3.5" />
            Delete
          </Button>
        </deleteFetcher.Form>
      )}
    </div>
  );
}

function CommentItem({
  comment,
  currentUserId,
  canModerate,
  canPost,
  isReply,
}: {
  comment: RenderedComment;
  currentUserId: number | null;
  canModerate: boolean;
  canPost: boolean;
  isReply: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [replying, setReplying] = useState(false);

  const isAuthor = currentUserId !== null && comment.author.id === currentUserId;

  if (comment.deleted) {
    return (
      <div className="py-3">
        <p className="text-sm italic text-muted-foreground">
          This comment was deleted.
        </p>
        <Replies
          comment={comment}
          currentUserId={currentUserId}
          canModerate={canModerate}
          canPost={canPost}
        />
      </div>
    );
  }

  return (
    <div className={cn("py-3", isReply && "border-l pl-4")}>
      <div className="flex items-start gap-3">
        <UserAvatar
          name={comment.author.name}
          avatarUrl={comment.author.avatarUrl}
          className="size-8 shrink-0"
        />

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{comment.author.name}</span>
            {comment.author.isInstructor && <AuthorBadge label="Instructor" />}
            {comment.author.isAdmin && <AuthorBadge label="Admin" />}
            <span
              className="text-xs text-muted-foreground"
              suppressHydrationWarning
            >
              {formatRelativeTime(comment.createdAt)}
            </span>
            {comment.editedAt && (
              <span
                className="text-xs text-muted-foreground"
                title={`Edited ${comment.editedAt}`}
              >
                (edited)
              </span>
            )}
          </div>

          {editing ? (
            <div className="mt-2">
              <CommentForm
                intent="edit-comment"
                commentId={comment.id}
                defaultValue={comment.body}
                placeholder="Edit your comment"
                submitLabel="Save changes"
                autoFocus
                onDone={() => setEditing(false)}
              />
            </div>
          ) : (
            <div
              className="prose prose-sm prose-neutral dark:prose-invert mt-1 max-w-none"
              dangerouslySetInnerHTML={{ __html: comment.bodyHtml }}
            />
          )}

          {!editing && (
            <CommentActions
              comment={comment}
              canEdit={isAuthor}
              canDelete={isAuthor || canModerate}
              canReply={canPost && !isReply}
              onEdit={() => setEditing(true)}
              onReply={() => setReplying(true)}
            />
          )}

          {replying && (
            <div className="mt-3">
              <CommentForm
                intent="create-comment"
                parentId={comment.id}
                placeholder={`Reply to ${comment.author.name}`}
                submitLabel="Post reply"
                autoFocus
                onDone={() => setReplying(false)}
              />
            </div>
          )}
        </div>
      </div>

      <Replies
        comment={comment}
        currentUserId={currentUserId}
        canModerate={canModerate}
        canPost={canPost}
      />
    </div>
  );
}

function Replies({
  comment,
  currentUserId,
  canModerate,
  canPost,
}: {
  comment: RenderedComment;
  currentUserId: number | null;
  canModerate: boolean;
  canPost: boolean;
}) {
  if (comment.replies.length === 0) return null;

  return (
    <div className="ml-11 mt-1 space-y-1">
      {comment.replies.map((reply) => (
        <CommentItem
          key={reply.id}
          comment={reply}
          currentUserId={currentUserId}
          canModerate={canModerate}
          canPost={canPost}
          isReply
        />
      ))}
    </div>
  );
}

export function CommentThread({
  comments,
  currentUserId,
  canModerate,
  canPost,
  instructorName,
}: {
  comments: RenderedComment[];
  currentUserId: number | null;
  /** Owning instructor or admin — may delete anyone's comment. */
  canModerate: boolean;
  canPost: boolean;
  instructorName: string;
}) {
  return (
    <Card className="mb-8">
      <CardContent className="p-6">
        <div className="mb-4 flex items-center gap-2">
          <MessageSquare className="size-5 text-primary" />
          <h2 className="text-xl font-semibold">Questions &amp; Discussion</h2>
        </div>

        {comments.length === 0 ? (
          <div className="rounded-lg border border-dashed p-6 text-center">
            <p className="font-medium">Stuck on this lesson?</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Ask here — {instructorName} answers questions in this course.
              There&apos;s no such thing as a question that&apos;s too basic.
            </p>
          </div>
        ) : (
          <div className="divide-y">
            {comments.map((comment) => (
              <CommentItem
                key={comment.id}
                comment={comment}
                currentUserId={currentUserId}
                canModerate={canModerate}
                canPost={canPost}
                isReply={false}
              />
            ))}
          </div>
        )}

        {canPost && (
          <div className="mt-6 border-t pt-6">
            <CommentForm
              intent="create-comment"
              placeholder="Ask a question or share what you found..."
              submitLabel="Post comment"
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
