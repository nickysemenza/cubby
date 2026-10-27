import { useIsFetching } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";

import { Spinner } from "~/ui/primitives/spinner";

/** Hide fast refreshes and reset the delay after every idle interval. */
function useDelayedRefresh(active: boolean) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!active) {
      setVisible(false);
      return;
    }
    const timer = setTimeout(() => setVisible(true), 300);
    return () => clearTimeout(timer);
  }, [active]);
  return active && visible;
}

/** Reserved sidebar space shared by refresh feedback and future shell work status. */
export function ShellStatusSlot({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-6 shrink-0 items-center justify-center px-2 text-xs text-muted-foreground">
      {children}
    </div>
  );
}

export function BackgroundRefreshStatus({
  compact = false,
  idle = null,
}: {
  compact?: boolean;
  /** Shell work status shown in the same slot while nothing is syncing. */
  idle?: ReactNode;
}) {
  const fetching = useIsFetching({
    predicate: (query) =>
      query.state.data !== undefined && Boolean(query.meta?.cacheTags?.length),
  });
  const visible = useDelayedRefresh(fetching > 0);
  return (
    <>
      {/* Keep view-local backlog observations alive while refresh feedback wins the slot. */}
      <div hidden={visible} className="w-full min-w-0">
        {idle}
      </div>
      {visible && (
        <output
          aria-label="Syncing"
          className="flex items-center gap-1.5 text-xs text-muted-foreground"
        >
          <Spinner size="sm" aria-hidden="true" />
          {!compact && <span>Syncing…</span>}
        </output>
      )}
    </>
  );
}
