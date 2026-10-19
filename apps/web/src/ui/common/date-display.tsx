import { useId, useState } from "react";

import {
  formatCompactRelative,
  formatInstant,
  formatRelative,
  formatTimestamp,
} from "~/lib/date-format";
import { dateSpanParts, stackedDateSpan, yearMark } from "~/lib/date-span";
import { householdLocalDate } from "~/lib/household-date";
import { cn } from "~/lib/utils";
import { StackedValue, useDenseCell } from "~/ui/common/stacked-value";
import { useDisplayNow } from "~/ui/hooks/use-display-now";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/ui/primitives/tooltip";

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
export function overdueDistance(relative: string): string {
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
      {primary}
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
  const tooltipId = useId();
  const [open, setOpen] = useState(false);

  if (props.timestamp === undefined) {
    const full = dateSpanParts(props.start, props.end ?? null, today);
    const span = stacked
      ? stackedDateSpan(props.start, props.end ?? null, today)
      : { primary: full.label, secondary: full.relative };
    const last = props.end ?? props.start;
    const overdue = props.due === true && last !== null && last < today;
    const parts = overdue
      ? {
          ...span,
          secondary: span.secondary && overdueDistance(span.secondary),
        }
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
  const year = formatInstant(date, "monthYear").slice(-4);
  const clock = props.clock && !stacked ? props.clock : null;
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
