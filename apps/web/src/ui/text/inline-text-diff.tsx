import { useMemo } from "react";

import { cn } from "~/lib/utils";

import { diffWords } from "./inline-text-diff.logic";

/**
 * Added runs are green; removed runs are red and struck through. Full review
 * surfaces wrap; incidental compact diffs truncate with a before/after tooltip.
 */
export function InlineTextDiff({
  before,
  after,
  className,
  wrap = false,
  afterLabel = "After",
  beforeLabel = "Before",
}: {
  before: string;
  after: string;
  className?: string;
  wrap?: boolean;
  afterLabel?: string;
  beforeLabel?: string;
}) {
  const segs = useMemo(() => diffWords(before, after), [before, after]);
  return (
    <span
      className={cn(
        "inline-block max-w-full min-w-0 align-bottom",
        wrap ? "break-words whitespace-pre-wrap" : "truncate",
        className,
      )}
      title={`${before || "(none)"} → ${after || "(none)"}`}
    >
      <span className="sr-only">
        {beforeLabel}: {before || "Empty"}. {afterLabel}: {after || "Empty"}.
      </span>
      <span aria-hidden="true">
        {segs.map((s, index) =>
          s.type === "common" ? (
            <span
              // oxlint-disable-next-line react/no-array-index-key -- Diff runs are positional, can repeat identical text, and carry no stable id.
              key={index}
            >
              {s.text}
            </span>
          ) : s.type === "add" ? (
            <ins
              // oxlint-disable-next-line react/no-array-index-key -- Diff runs are positional, can repeat identical text, and carry no stable id.
              key={index}
              className="rounded-xs bg-positive/15 px-0.5 text-positive no-underline" /* tight: inline word-diff highlight */
            >
              {s.text}
            </ins>
          ) : (
            <del
              // oxlint-disable-next-line react/no-array-index-key -- Diff runs are positional, can repeat identical text, and carry no stable id.
              key={index}
              className="rounded-xs bg-destructive/15 px-0.5 text-destructive line-through" /* tight: inline word-diff highlight */
            >
              {s.text}
            </del>
          ),
        )}
      </span>
    </span>
  );
}
