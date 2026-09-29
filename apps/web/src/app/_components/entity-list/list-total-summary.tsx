import type { EntitySummary } from "@cubby/schemas/entity-summary";

import { formatCurrencyRange } from "~/lib/format-range";
import { formatCount, formatCurrency } from "~/lib/utils";

type ListTotalDescriptor = Omit<
  EntitySummary["list"]["totals"][number],
  "keys"
> & {
  readonly keys: readonly [string] | readonly [string, string];
};

function totalValue(
  total: ListTotalDescriptor,
  sums?: Record<string, number>,
): string | null {
  const values = total.keys.map((key) => sums?.[key]);
  if (values.some((value) => value === undefined || !Number.isFinite(value)))
    return null;
  const first = values[0]!;
  switch (total.format) {
    case "currency":
      return formatCurrency(first);
    case "currencyRange":
      return formatCurrencyRange(first, values[1]!);
    case "integer":
      return formatCount(first);
  }
}

/** Declared totals always describe the server's full filtered result. */
export function ListTotalSummary({
  totals,
  sums,
}: {
  totals: readonly ListTotalDescriptor[];
  sums?: Record<string, number>;
}) {
  const values = totals.map((total) => ({
    id: total.id,
    label: total.label,
    value: totalValue(total, sums) ?? "Unavailable",
  }));
  if (values.length === 0) return null;
  return (
    <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1 text-sm">
      <span className="text-muted-foreground">All matching</span>
      <dl className="flex flex-wrap items-baseline gap-x-5 gap-y-1">
        {values.map(({ id, label, value }) => (
          <div key={id} className="flex min-w-0 items-baseline gap-1.5">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="font-medium tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
