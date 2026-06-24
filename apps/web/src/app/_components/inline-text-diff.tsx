import { useMemo } from "react";
import { cn } from "~/lib/utils";
import { diffWords } from "./inline-text-diff.logic";

/**
 * One-line inline diff of two strings — added runs green, removed runs red-struck. The
 * full `before → after` is in the native tooltip. Truncates with ellipsis so a long
 * modifier stays one line.
 */
export function InlineTextDiff({
  before,
  after,
  className,
}: {
  before: string;
  after: string;
  className?: string;
}) {
  const segs = useMemo(() => diffWords(before, after), [before, after]);
  return (
    <span
      className={cn("inline-block max-w-full truncate align-bottom", className)}
      title={`${before || "(none)"} → ${after || "(none)"}`}
    >
      {segs.map((s, idx) =>
        s.type === "common" ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: positional diff segments
          <span key={idx}>{s.text}</span>
        ) : s.type === "add" ? (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: positional diff segments
            key={idx}
            className="rounded-xs bg-positive/15 px-0.5 text-positive"
          >
            {s.text}
          </span>
        ) : (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: positional diff segments
            key={idx}
            className="rounded-xs bg-destructive/15 px-0.5 text-destructive line-through"
          >
            {s.text}
          </span>
        ),
      )}
    </span>
  );
}
