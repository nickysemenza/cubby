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
      {segs.map((s, index) =>
        s.type === "common" ? (
          <span
            // oxlint-disable-next-line react/no-array-index-key -- Diff runs are positional, can repeat identical text, and carry no stable id.
            key={index}
          >
            {s.text}
          </span>
        ) : s.type === "add" ? (
          <span
            // oxlint-disable-next-line react/no-array-index-key -- Diff runs are positional, can repeat identical text, and carry no stable id.
            key={index}
            className="rounded-xs bg-positive/15 px-0.5 text-positive" /* tight: inline word-diff highlight */
          >
            {s.text}
          </span>
        ) : (
          <span
            // oxlint-disable-next-line react/no-array-index-key -- Diff runs are positional, can repeat identical text, and carry no stable id.
            key={index}
            className="rounded-xs bg-destructive/15 px-0.5 text-destructive line-through" /* tight: inline word-diff highlight */
          >
            {s.text}
          </span>
        ),
      )}
    </span>
  );
}
