import type { EntitySummary } from "@cubby/schemas/entity-summary";
import type { ListGroupMetric } from "@cubby/schemas/pagination";

import { ListMetricValue } from "~/entity/entity-list/list-evidence-summary";
import { KeyNumbers } from "~/ui/records/key-numbers";

type ListTotalDescriptor = Pick<
  EntitySummary["list"]["totals"][number],
  "id" | "label"
> & { metricKey?: string; format?: string };

/**
 * Declared totals always describe the server's full filtered result. A total
 * with no answer yet reads as pending; "Unavailable" means its read failed, or
 * the server answered without it.
 */
export function ListTotalSummary({
  totals,
  labels,
  failed = false,
  scopeLabel,
  metrics,
}: {
  totals: readonly ListTotalDescriptor[];
  /** The server's text for each total, by id; undefined until a page answers. */
  labels?: Record<string, string>;
  failed?: boolean;
  /** Qualifies the totals when they do not cover every matching record. */
  scopeLabel?: string;
  metrics?: Readonly<Record<string, ListGroupMetric>>;
}) {
  const values = totals.map((total) => ({
    id: total.id,
    label: total.label,
    value: total.metricKey ? (
      metrics === undefined && !failed ? (
        "…"
      ) : (
        <ListMetricValue
          value={metrics?.[total.metricKey]}
          format={total.format ?? "integer"}
        />
      )
    ) : (
      (labels?.[total.id] ??
      (labels !== undefined || failed ? "Unavailable" : "…"))
    ),
  }));
  if (values.length === 0) return null;
  return (
    <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-xs [&_dl]:flex-wrap [&_dl]:text-xs">
      {scopeLabel && (
        <span className="text-muted-foreground">{scopeLabel}</span>
      )}
      <KeyNumbers
        layout="inline"
        label={`${scopeLabel ?? "List"} totals`}
        items={values}
      />
    </div>
  );
}
