import { cn } from "cn";

import { Progress } from "~/ui/shadcn/progress";
import { Spinner } from "~/ui/shadcn/spinner";

/**
 * The shared "{verb} X of N" + bar shown while a streamed bulk operation runs
 * (see `useBulkStream`). Pass the hook's `progress`; `null` (before the first
 * event) renders an indeterminate bar with a "{verb}…" label.
 */
export function BulkProgressBar({
  verb,
  progress,
  className,
}: {
  /** Present-continuous label, e.g. "Importing", "Reprocessing". */
  verb: string;
  progress: { done: number; total: number } | null;
  className?: string;
}) {
  return (
    <div className={cn("space-y-1", className)}>
      <p className="flex items-center gap-1 text-xs text-muted-foreground">
        <Spinner className="size-3" />{" "}
        {progress
          ? `${verb} ${progress.done} of ${progress.total}`
          : `${verb}…`}
      </p>
      <Progress
        value={progress?.done ?? 0}
        max={progress?.total ?? 1}
        indeterminate={!progress}
      />
    </div>
  );
}
