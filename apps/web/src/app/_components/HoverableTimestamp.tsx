import { format, formatDistanceToNow } from "date-fns";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "~/components/ui/tooltip";

type HoverableTimestampProps = {
  timestamp: string | Date;
};

export function HoverableTimestamp({ timestamp }: HoverableTimestampProps) {
  const date = new Date(timestamp);
  const formattedDate = format(date, "yyyy-MM-dd HH:mm:ss");
  const relativeTime = formatDistanceToNow(date, { addSuffix: true });

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger className="cursor-default">
          <span className="font-mono text-2xs">{relativeTime}</span>
        </TooltipTrigger>
        <TooltipContent>
          <p>{formattedDate}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
