import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "~/components/ui/tooltip";

type HoverableTimestampProps = {
  timestamp: string | Date;
};
dayjs.extend(relativeTime);

export function HoverableTimestamp({ timestamp }: HoverableTimestampProps) {
  const formattedDate = dayjs(timestamp).format("YYYY-MM-DD HH:mm:ss");
  const relativeTime = dayjs(timestamp).fromNow();

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger className="cursor-default">
          <span>{relativeTime}</span>
        </TooltipTrigger>
        <TooltipContent>
          <p>{formattedDate}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
