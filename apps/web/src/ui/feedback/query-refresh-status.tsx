import { useHydrated } from "~/ui/hooks/use-hydrated";
import { Spinner } from "~/ui/primitives/spinner";

import { ErrorDisplay } from "./error-display";

/** Freshness is independent of whether the preceding write was accepted. */
export function QueryRefreshStatus({
  refreshing,
  error,
  onRetry,
}: {
  refreshing: boolean;
  error?: unknown;
  onRetry?: () => void;
}) {
  // The shell can start a refresh before this streamed section hydrates.
  const hydrated = useHydrated();
  if (!hydrated) return null;
  if (error)
    return (
      <div className="py-2">
        <p className="text-xs text-muted-foreground">
          This view may be out of date. Saved changes are retained.
        </p>
        <ErrorDisplay error={error} title="updated data" onRetry={onRetry} />
      </div>
    );
  if (!refreshing) return null;
  return (
    <output className="flex items-center gap-1.5 py-1 text-xs text-muted-foreground">
      <Spinner size="sm" />
      Updating…
    </output>
  );
}
