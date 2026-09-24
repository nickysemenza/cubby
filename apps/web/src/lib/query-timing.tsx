import { ClockIcon as Clock } from "@phosphor-icons/react/dist/csr/Clock";
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
        "flex items-center gap-1 text-xs text-muted-foreground",
        className,
      )}
    >
      <Clock className="size-3" aria-hidden="true" />
      {displayText}
    </span>
  );
};
