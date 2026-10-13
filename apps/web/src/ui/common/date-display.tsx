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
} & (
  | { timestamp: string | Date | number; start?: never; end?: never }
  | { start: string | null; end?: string | null; timestamp?: never }
);

function DateContents({
  primary,
  secondary,
  stacked,
}: {
  primary: string;
  secondary: string | null;
  stacked: boolean;
}) {
  if (stacked)
    return (
      <StackedValue
        primary={primary}
        secondary={secondary}
        suppressSecondaryHydrationWarning
      />
    );
  return (
    <>
      {primary}
      {secondary && (
        <span className="text-muted-foreground" suppressHydrationWarning>
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
    const parts = stacked
      ? stackedDateSpan(props.start, props.end ?? null, today)
      : { primary: full.label, secondary: full.relative };
    return (
      <span
        className={props.className}
        title={full.relative ? `${full.label} · ${full.relative}` : full.label}
      >
        <DateContents {...parts} stacked={stacked} />
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
  const secondary =
    stacked && year !== today.slice(0, 4)
      ? `${yearMark(year)} · ${relative}`
      : relative;
  const primary = formatInstant(date, stacked ? "monthDay" : "dateShortTime");

  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger
        render={
          <button type="button" aria-label={formatTimestamp(date, now)} />
        }
        aria-describedby={open ? tooltipId : undefined}
        className={cn(
          "cursor-default text-left",
          stacked ? "block max-w-full min-w-0" : "inline whitespace-normal",
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
      </TooltipContent>
    </Tooltip>
  );
}
