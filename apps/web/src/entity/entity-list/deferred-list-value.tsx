import type { ReactNode } from "react";

import type { ListGroupState } from "../../ui/hooks/progressive-list";

/** Keep the cell's footprint while its field is unavailable. */
export function DeferredListValue({
  state,
  children,
  label = "field",
}: {
  state?: ListGroupState;
  children?: ReactNode;
  label?: string;
}) {
  if (!state || state.state === "ready") return children;
  if (state.state === "pending" || state.state === "loading")
    return (
      <span
        aria-label={`Loading ${label}`}
        aria-busy="true"
        className="inline-block h-3 w-12 rounded-sm bg-muted"
      />
    );
  return (
    <span
      className="text-xs text-muted-foreground"
      title={
        state.state === "error" ? state.error : "Record is no longer available"
      }
    >
      Unavailable
    </span>
  );
}
