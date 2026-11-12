import { cn } from "cn";
import { useContext, useId, useState } from "react";

import {
  formatCompactRelative,
  formatInstant,
  formatRelative,
  formatTimestamp,
} from "~/lib/date-format";
import { dateSpanParts, stackedDateSpan, yearMark } from "~/lib/date-span";
import { householdLocalDate } from "~/lib/household-date";
import { useDisplayNow } from "~/ui/hooks/use-display-now";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/ui/primitives/tooltip";
import { useCompactFacts } from "~/ui/records/facts";
import {
  DenseCellContext,
  StackedValue,
  useDenseCell,
} from "~/ui/values/stacked-value";

type DateDisplayProps = {
  className?: string;
  /** Defaults to the compact, two-line form inside a desktop table cell. */
  stacked?: boolean;
  /**
   * A row in a list that prints its day elsewhere: `time` prints only the clock time, `day` the
   * day and time; both keep the relative distance in the tooltip instead of inline.
   */
  clock?: "time" | "day";
  /**
   * The date is an open record's deadline: once its last day has passed it
   * reads destructive and its distance says "overdue" instead of "ago".
   */
  due?: boolean;
} & (
  | { timestamp: string | Date | number; start?: never; end?: never }
  | { start: string | null; end?: string | null; timestamp?: never }
);

/** "yesterday" / "5d ago" as a deadline's distance: "1d overdue" / "5d overdue". */
function overdueDistance(relative: string): string {
  return relative
    .replace(/^yesterday$/, "1d overdue")
    .replace(/ ago$/, " overdue");
}

function DateContents({
  primary,
  secondary,
  stacked,
  overdue = false,
}: {
  primary: string;
  secondary: string | null;
  stacked: boolean;
  overdue?: boolean;
}) {
  if (stacked)
    return (
      <StackedValue
        primary={primary}
        secondary={secondary}
        secondaryClassName={overdue ? "text-destructive" : undefined}
        suppressSecondaryHydrationWarning
      />
    );
  return (
    <>
      <span className="tabular-nums">{primary}</span>
      {secondary && (
        <span
          className={overdue ? "text-destructive" : "text-muted-foreground"}
          suppressHydrationWarning
        >
          {" · "}
          {secondary}
        </span>
      )}
    </>
  );
}

/** Record dates and instants share one full/compact presentation on every surface. */
export function DateDisplay(props: DateDisplayProps) {
  const now = useDisplayNow() ?? Date.now();
  const today = householdLocalDate(new Date(now));
  const stacked = useDenseCell(props.stacked);
  const inCell = useContext(DenseCellContext) !== null;
  // A compact fact list is narrow: an instant reads "Nov 11, 4:25 PM" on one
  // line, its distance in the tooltip.
  const compactFact = useCompactFacts();
  const tooltipId = useId();
  const [open, setOpen] = useState(false);

  if (props.timestamp === undefined) {
    const full = dateSpanParts(props.start, props.end ?? null, today);
    const span = stacked
      ? stackedDateSpan(props.start, props.end ?? null, today)
      : { primary: full.label, secondary: full.relative };
    const last = props.end ?? props.start;
    const overdue = props.due === true && last !== null && last < today;
    // A compact fact keeps the day on one line; its distance stays in the
    // title unless the date is overdue.
    const parts = overdue
      ? {
          ...span,
          secondary: span.secondary && overdueDistance(span.secondary),
        }
      : compactFact && !stacked
        ? { ...span, secondary: null }
        : span;
    const relative =
      overdue && full.relative ? overdueDistance(full.relative) : full.relative;
    return (
      <span
        className={cn(overdue && "text-destructive", props.className)}
        data-overdue={overdue ? "" : undefined}
        title={relative ? `${full.label} · ${relative}` : full.label}
      >
        <DateContents {...parts} stacked={stacked} overdue={overdue} />
      </span>
    );
  }

  const date = new Date(props.timestamp);
  if (Number.isNaN(date.getTime()))
    return <span className={props.className}>Invalid Date</span>;
  const relative = stacked
    ? formatCompactRelative(date, now)
    : formatRelative(date, now);
  // A list cell's instant is its age alone ("15h", "now"); the day and exact
  // time stay in the tooltip and accessible name.
  if (stacked && inCell && !props.clock)
    return (
      <Tooltip open={open} onOpenChange={setOpen}>
        <TooltipTrigger
          render={
            <button type="button" aria-label={formatTimestamp(date, now)} />
          }
          aria-describedby={open ? tooltipId : undefined}
          className={cn(
            "block max-w-full min-w-0 cursor-default truncate text-left tabular-nums",
            props.className,
          )}
        >
          <time dateTime={date.toISOString()} suppressHydrationWarning>
            {relative.replace(/ ago$/, "")}
          </time>
        </TooltipTrigger>
        <TooltipContent id={tooltipId} role="tooltip">
          <p>{formatInstant(date, "timestampExact")}</p>
        </TooltipContent>
      </Tooltip>
    );
  const year = formatInstant(date, "monthYear").slice(-4);
  const clock =
    props.clock && !stacked
      ? props.clock
      : compactFact && !stacked
        ? "day"
        : null;
  const secondary = clock
    ? null
    : stacked && year !== today.slice(0, 4)
      ? `${yearMark(year)} · ${relative}`
      : relative;
  const primary = formatInstant(
    date,
    clock === "time"
      ? "clock"
      : clock === "day"
        ? year === today.slice(0, 4)
          ? "monthDayTime"
          : "dateShortTime"
        : stacked
          ? "monthDay"
          : "dateShortTime",
  );

  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger
        render={
          <button type="button" aria-label={formatTimestamp(date, now)} />
        }
        aria-describedby={open ? tooltipId : undefined}
        className={cn(
          "cursor-default text-left",
          clock && "tabular-nums",
          stacked
            ? "block max-w-full min-w-0"
            : "inline-block max-w-full min-w-0 align-baseline whitespace-normal",
          props.className,
        )}
      >
        <time dateTime={date.toISOString()}>
          <DateContents
            primary={primary}
            secondary={secondary}
            stacked={stacked}
          />
        </time>
      </TooltipTrigger>
      <TooltipContent id={tooltipId} role="tooltip">
        <p>{formatInstant(date, "timestampExact")}</p>
        {clock ? (
          <p className="opacity-70" suppressHydrationWarning>
            {formatRelative(date, now)}
          </p>
        ) : null}
      </TooltipContent>
    </Tooltip>
  );
}
