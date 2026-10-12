import { useId, useState } from "react";

import { formatInstant } from "~/lib/date-format";
import { yearMark } from "~/lib/date-span";
import { StackedValue, useStackedCell } from "~/ui/common/stacked-value";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "~/ui/primitives/tooltip";

type HoverableTimestampProps = {
  timestamp: string | Date;
  /**
   * Table-cell form: the household day over its compact age ("3mo ago").
   * Defaults on inside a desktop table cell.
   */
  stacked?: boolean;
};

/** Compact relative time: `now`, `5m`, `3h`, `2d`, `4w`, `6mo`, `1y`. */
export function formatCompactRelative(date: Date): string {
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (seconds < 45) return "now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.round(days / 7);
  if (days < 30) return `${weeks}w`;
  const months = Math.round(days / 30);
  if (days < 365) return `${months}mo`;
  return `${Math.round(days / 365)}y`;
}

/**
 * The household day over its age, "Oct 11" / "3mo ago"; another year leads
 * the age line ("’25 · 1y ago"), as stacked plain dates do.
 */
function stackedInstant(date: Date, relativeTime: string) {
  const year = (value: Date) => formatInstant(value, "monthYear").slice(-4);
  const age = relativeTime === "now" ? "now" : `${relativeTime} ago`;
  const shown = year(date);
  return {
    primary: formatInstant(date, "monthDay"),
    secondary: shown === year(new Date()) ? age : `${yearMark(shown)} · ${age}`,
  };
}

export function HoverableTimestamp({
  timestamp,
  stacked,
}: HoverableTimestampProps) {
  const tooltipId = useId();
  const [open, setOpen] = useState(false);
  const stack = useStackedCell(stacked);
  const date = new Date(timestamp);
  const formattedDate = formatInstant(date, "isoDateTimeSeconds");
  const relativeTime = formatCompactRelative(date);
  return (
    <TooltipProvider>
      <Tooltip open={open} onOpenChange={setOpen}>
        <TooltipTrigger
          aria-describedby={open ? tooltipId : undefined}
          className={
            stack
              ? "block max-w-full min-w-0 cursor-default text-left"
              : "inline-flex min-h-11 min-w-11 cursor-default items-center justify-center md:min-h-0 md:min-w-0"
          }
        >
          {stack ? (
            <StackedValue {...stackedInstant(date, relativeTime)} />
          ) : (
            <span className="font-mono text-2xs">{relativeTime}</span>
          )}
        </TooltipTrigger>
        <TooltipContent id={tooltipId} role="tooltip">
          <p>{formattedDate}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
