import { cn } from "~/lib/utils";

/** A code keeps this many characters at each end when it truncates. */
const CODE_ENDS = 4;

type TailLabel =
  | { kind: "path"; head: string; tail: string }
  | { kind: "code"; head: string; middle: string; tail: string };

/**
 * Splits a URL or slash path so a list cell can shrink its shared prefix and
 * keep the distinguishing tail, and a code so it keeps its first and last
 * four characters ("0123…8905"). End-truncating a column of URLs from one
 * host printed the same "https://media…." on every row, and a column of one
 * vendor's order numbers the same "113-21…".
 */
function splitTailLabel(label: string): TailLabel | null {
  if (/\s/.test(label)) return null;
  const path = splitPathLabel(label);
  if (path) return { kind: "path", ...path };
  if (label.length < CODE_ENDS * 2 + 3) return null;
  return {
    kind: "code",
    head: label.slice(0, CODE_ENDS),
    middle: label.slice(CODE_ENDS, -CODE_ENDS),
    tail: label.slice(-CODE_ENDS),
  };
}

function splitPathLabel(label: string): { head: string; tail: string } | null {
  let path = label;
  let host = "";
  if (/^https?:\/\//i.test(label)) {
    try {
      const url = new URL(label);
      host = url.host;
      path = url.pathname;
    } catch {
      return null;
    }
  }
  const segments = path.split("/").filter(Boolean);
  const tail = segments.at(-1);
  if (!tail || (segments.length < 2 && !host)) return null;
  const head = [host, ...segments.slice(0, -1)].filter(Boolean).join("/");
  return { head: `${head}/`, tail: safeDecode(tail) };
}

function safeDecode(segment: string) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * One-line text that truncates in the middle when it has a distinguishing
 * tail, else at the end. `data-cell-spill` marks the whole value as what a
 * clipped table cell spills on hover. A code always shows "0123…8905": its
 * middle stays in the text but takes no width (`data-fit-elide`) and a drawn
 * "…" stands in (`data-spill-omit`). Regression: a one-ellipsis-wide
 * `text-overflow` box showed one digit instead, since Chrome keeps the first
 * character when the ellipsis does not fit beside it.
 */
export function MiddleTruncate({
  text,
  title,
  className,
}: {
  text: string;
  title?: string;
  className?: string;
}) {
  const parts = splitTailLabel(text);
  if (!parts)
    return (
      <span
        data-cell-spill=""
        className={cn("block truncate", className)}
        title={title}
      >
        {text}
      </span>
    );
  if (parts.kind === "code")
    return (
      <span
        data-cell-spill=""
        className={cn("flex min-w-0", className)}
        title={title}
      >
        <span className="shrink-0">{parts.head}</span>
        <span
          data-fit-elide=""
          className="max-w-0 overflow-hidden whitespace-nowrap"
        >
          {parts.middle}
        </span>
        <span aria-hidden="true" data-spill-omit="">
          …
        </span>
        <span className="shrink-0">{parts.tail}</span>
      </span>
    );
  return (
    <span
      data-cell-spill=""
      className={cn("flex min-w-0", className)}
      title={title}
    >
      <span className="min-w-[1.5ch] shrink truncate text-muted-foreground">
        {parts.head}
      </span>
      <span className="min-w-0 [flex-shrink:0.001] truncate">{parts.tail}</span>
    </span>
  );
}
