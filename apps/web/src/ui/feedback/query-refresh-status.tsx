import { useDelayedActive } from "~/ui/hooks/use-delayed-active";
import { useHydrated } from "~/ui/hooks/use-hydrated";
import { Description } from "~/ui/text/description";

import { ErrorDisplay } from "./error-display";

/** Freshness is independent of whether the preceding write was accepted. */
export function QueryRefreshStatus({
  error,
  isRefreshing = false,
  onRetry,
}: {
  error?: unknown;
  isRefreshing?: boolean;
  onRetry?: () => void;
}) {
  // The shell can start a refresh before this streamed section hydrates.
  const hydrated = useHydrated();
  const updating = useDelayedActive(hydrated && isRefreshing);

  if (hydrated && error)
    return (
      <div className="py-2">
        <Description size="xs">
          This view may be out of date. Saved changes are retained.
        </Description>
        <ErrorDisplay error={error} title="updated data" onRetry={onRetry} />
      </div>
    );
  return (
    <output className="block min-h-4 text-xs text-muted-foreground">
      {updating ? "Updating…" : null}
    </output>
  );
}
