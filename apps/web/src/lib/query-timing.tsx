import { Clock } from "lucide-react";
import type { FC } from "react";
import { cn } from "~/lib/utils";

export interface QueryTiming {
  durationMs: number | null;
  isFresh: boolean;
}

interface QueryTimingIndicatorProps {
  timing: QueryTiming;
  className?: string;
}

export const QueryTimingIndicator: FC<QueryTimingIndicatorProps> = ({
  timing,
  className,
}) => {
  if (timing.durationMs === null) {
    return null;
  }

  const displayText = timing.isFresh
    ? `Loaded in ${timing.durationMs}ms`
    : "From cache";

  return (
    <span
      className={cn(
        "flex items-center gap-1 text-muted-foreground text-xs",
        className,
      )}
    >
      <Clock className="size-3" aria-hidden="true" />
      {displayText}
    </span>
  );
};
