import { format } from "date-fns";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "~/components/ui/tooltip";

type HoverableTimestampProps = {
  timestamp: string | Date;
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

export function HoverableTimestamp({ timestamp }: HoverableTimestampProps) {
  const date = new Date(timestamp);
  const formattedDate = format(date, "yyyy-MM-dd HH:mm:ss");
  const relativeTime = formatCompactRelative(date);

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger className="inline-flex min-h-10 min-w-10 cursor-default items-center justify-center md:min-h-0 md:min-w-0">
          <span className="font-mono text-2xs">{relativeTime}</span>
        </TooltipTrigger>
        <TooltipContent>
          <p>{formattedDate}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
