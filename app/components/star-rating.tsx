import { useState } from "react";
import { Star } from "lucide-react";
import { cn } from "~/lib/utils";
import { MAX_RATING } from "~/lib/ratings";

const STARS = Array.from({ length: MAX_RATING }, (_, i) => i + 1);

/**
 * Read-only average rating display. Renders partially-filled stars by clipping
 * a filled star over an outlined one.
 */
export function StarRating({
  average,
  count,
  size = "sm",
  showCount = true,
  className,
}: {
  average: number | null;
  count: number;
  size?: "sm" | "md";
  showCount?: boolean;
  className?: string;
}) {
  const starSize = size === "md" ? "size-5" : "size-4";

  if (average === null || count === 0) {
    return (
      <span className={cn("text-xs text-muted-foreground", className)}>
        No ratings yet
      </span>
    );
  }

  return (
    <span
      className={cn("flex items-center gap-1.5", className)}
      aria-label={`Rated ${average} out of ${MAX_RATING} from ${count} ${
        count === 1 ? "rating" : "ratings"
      }`}
    >
      <span className="flex items-center">
        {STARS.map((star) => {
          const fillPercent = Math.max(
            0,
            Math.min(1, average - (star - 1))
          );
          return (
            <span key={star} className="relative">
              <Star className={cn(starSize, "text-muted-foreground/40")} />
              {fillPercent > 0 && (
                <span
                  className="absolute inset-0 overflow-hidden"
                  style={{ width: `${fillPercent * 100}%` }}
                >
                  <Star
                    className={cn(starSize, "fill-amber-400 text-amber-400")}
                  />
                </span>
              )}
            </span>
          );
        })}
      </span>
      <span
        className={cn(
          "font-medium text-foreground",
          size === "md" ? "text-sm" : "text-xs"
        )}
      >
        {average.toFixed(1)}
      </span>
      {showCount && (
        <span
          className={cn(
            "text-muted-foreground",
            size === "md" ? "text-sm" : "text-xs"
          )}
        >
          ({count})
        </span>
      )}
    </span>
  );
}

/**
 * Interactive star picker. Each star is a submit button, so it works without
 * JavaScript when rendered inside a form.
 */
export function StarRatingInput({
  value,
  name = "rating",
  disabled = false,
  className,
}: {
  value: number | null;
  name?: string;
  disabled?: boolean;
  className?: string;
}) {
  const [hovered, setHovered] = useState<number | null>(null);
  const active = hovered ?? value ?? 0;

  return (
    <span
      className={cn("flex items-center gap-0.5", className)}
      onMouseLeave={() => setHovered(null)}
    >
      {STARS.map((star) => (
        <button
          key={star}
          type="submit"
          name={name}
          value={star}
          disabled={disabled}
          onMouseEnter={() => setHovered(star)}
          onFocus={() => setHovered(star)}
          onBlur={() => setHovered(null)}
          aria-label={`Rate ${star} out of ${MAX_RATING}`}
          className="rounded p-0.5 transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Star
            className={cn(
              "size-6",
              star <= active
                ? "fill-amber-400 text-amber-400"
                : "text-muted-foreground/40"
            )}
          />
        </button>
      ))}
    </span>
  );
}
