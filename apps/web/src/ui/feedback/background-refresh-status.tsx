import { useIsFetching } from "@tanstack/react-query";
import { type ReactNode } from "react";

import { useDelayedActive } from "~/ui/hooks/use-delayed-active";
import { Spinner } from "~/ui/primitives/spinner";

/** Reserved sidebar space for refresh feedback. */
export function ShellStatusSlot({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-6 shrink-0 items-center justify-center px-2 text-xs text-muted-foreground">
      {children}
    </div>
  );
}

export function BackgroundRefreshStatus({
  compact = false,
}: {
  compact?: boolean;
}) {
  const fetching = useIsFetching({
    predicate: (query) =>
      query.state.data !== undefined && Boolean(query.meta?.cacheTags?.length),
  });
  const visible = useDelayedActive(fetching > 0);
  if (!visible) return null;
  return (
    <output
      aria-label="Syncing"
      className="flex items-center gap-1.5 text-xs text-muted-foreground"
    >
      <Spinner size="sm" aria-hidden="true" />
      {!compact && <span>Syncing…</span>}
    </output>
  );
}
