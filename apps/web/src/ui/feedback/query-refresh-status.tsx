import { useHydrated } from "~/ui/hooks/use-hydrated";

import { ErrorDisplay } from "./error-display";

/** Freshness is independent of whether the preceding write was accepted. */
export function QueryRefreshStatus({
  error,
  onRetry,
}: {
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
  return null;
}
