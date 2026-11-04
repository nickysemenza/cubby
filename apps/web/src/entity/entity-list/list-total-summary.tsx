import type { EntitySummary } from "@cubby/schemas/entity-summary";

import { KeyNumbers } from "~/ui/common/key-numbers";

type ListTotalDescriptor = Pick<
  EntitySummary["list"]["totals"][number],
  "id" | "label"
>;

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
}: {
  totals: readonly ListTotalDescriptor[];
  /** The server's text for each total, by id; undefined until a page answers. */
  labels?: Record<string, string>;
  failed?: boolean;
  /** Qualifies the totals when they do not cover every matching record. */
  scopeLabel?: string;
}) {
  const values = totals.map((total) => ({
    id: total.id,
    label: total.label,
    value:
      labels?.[total.id] ??
      (labels !== undefined || failed ? "Unavailable" : "…"),
  }));
  if (values.length === 0) return null;
  return (
    <div className="flex min-w-0 items-baseline gap-x-2 text-xs whitespace-nowrap [&_dl]:flex-nowrap [&_dl]:text-xs">
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
