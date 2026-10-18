import type { EntitySummary } from "@cubby/schemas/entity-summary";

import { FactList } from "~/ui/common/fact-list";
import { ErrorDetails } from "~/ui/feedback/error-details";
import { Button } from "~/ui/primitives/button";

import type { ListGroupState } from "../hooks/progressive-list";

type ListTotalDescriptor = Pick<
  EntitySummary["list"]["totals"][number],
  "id" | "label"
>;

/** Declared totals always describe the server's full filtered result. */
export function ListTotalSummary({
  totals,
  labels,
  state,
  onRetry,
}: {
  totals: readonly ListTotalDescriptor[];
  /** The server's text for each total, by id; a missing one is unavailable. */
  labels?: Record<string, string>;
  state?: ListGroupState;
  onRetry?: () => void;
}) {
  const values = totals.map((total) => ({
    id: total.id,
    label: total.label,
    value:
      state?.state === "pending" || state?.state === "loading"
        ? "Loading…"
        : (labels?.[total.id] ?? "Unavailable"),
  }));
  if (values.length === 0) return null;
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs">
      <span className="text-muted-foreground">All matching</span>
      {state?.state === "error" && (
        <span role="alert" className="text-destructive">
          {state.error}
        </span>
      )}
      {state?.state === "error" && (
        <>
          <ErrorDetails error={state.cause} />
          {onRetry && (
            <Button variant="outline" size="sm" onClick={onRetry}>
              Retry totals
            </Button>
          )}
        </>
      )}
      <FactList
        emphasis="value"
        facts={values.map(({ id, label, value }) => ({
          id,
          label,
          value,
          className: "font-medium tabular-nums",
        }))}
      />
    </div>
  );
}
