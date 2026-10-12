import { cn } from "~/lib/utils";

/**
 * Splits a URL, slash path, or code so a list cell can shrink its shared
 * prefix and keep the distinguishing tail. End-truncating a column of URLs
 * from one host printed the same "https://media…." on every row, and a column
 * of one vendor's order numbers the same "113-21…".
 */
export function splitTailLabel(
  label: string,
): { head: string; tail: string; muted: boolean } | null {
  if (/\s/.test(label)) return null;
  const path = splitPathLabel(label);
  if (path) return { ...path, muted: true };
  if (label.length <= 8) return null;
  const separator = Math.max(
    ...["-", "_", ".", ":", "#"].map((mark) => label.lastIndexOf(mark)),
  );
  const tailLength = label.length - separator - 1;
  const cut =
    separator > 0 && tailLength >= 3 && tailLength <= 12
      ? separator + 1
      : label.length - 6;
  return { head: label.slice(0, cut), tail: label.slice(cut), muted: false };
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
 * clipped table cell spills on hover.
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
  return (
    <span
      data-cell-spill=""
      className={cn("flex min-w-0", className)}
      title={title}
    >
      <span
        className={cn(
          "min-w-[1.5ch] shrink truncate",
          parts.muted && "text-muted-foreground",
        )}
      >
        {parts.head}
      </span>
      <span className="min-w-0 [flex-shrink:0.001] truncate">{parts.tail}</span>
    </span>
  );
}
