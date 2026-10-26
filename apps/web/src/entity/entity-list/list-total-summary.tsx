import type { EntitySummary } from "@cubby/schemas/entity-summary";

import { KeyNumbers } from "~/ui/common/key-numbers";

type ListTotalDescriptor = Pick<
  EntitySummary["list"]["totals"][number],
  "id" | "label"
>;

/** Declared totals always describe the server's full filtered result. */
export function ListTotalSummary({
  totals,
  labels,
}: {
  totals: readonly ListTotalDescriptor[];
  /** The server's text for each total, by id; a missing one is unavailable. */
  labels?: Record<string, string>;
}) {
  const values = totals.map((total) => ({
    id: total.id,
    label: total.label,
    value: labels?.[total.id] ?? "Unavailable",
  }));
  if (values.length === 0) return null;
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs">
      <span className="text-muted-foreground">All matching</span>
      <KeyNumbers layout="inline" label="All matching totals" items={values} />
    </div>
  );
}
