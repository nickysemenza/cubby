import type { EntitySummary } from "@cubby/schemas/entity-summary";
import type { ListGroupMetric } from "@cubby/schemas/pagination";
import { InfoIcon } from "@phosphor-icons/react/dist/csr/Info";

import { formatCount } from "~/lib/number-format";
import { Button } from "~/ui/primitives/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "~/ui/primitives/popover";
import { CurrencyValue } from "~/ui/values/currency-value";

type MetricDefinition = EntitySummary["list"]["evidenceMetrics"][number];

/** Unknown contributions remain visible beside the known signed subtotal. */
export function ListMetricValue({
  value,
  format,
}: {
  value: ListGroupMetric | undefined;
  format: string;
}) {
  if (!value) return <span>Unavailable</span>;
  return (
    <>
      {value.sum === null ? (
        "Unknown"
      ) : format === "currency" || format === "signedCurrency" ? (
        <CurrencyValue value={value.sum} interactive={false} tone={false} />
      ) : (
        formatCount(value.sum)
      )}
      {value.presentCount < value.totalCount && (
        <span className="ml-1 text-muted-foreground">partial</span>
      )}
    </>
  );
}

/** Compact amounts with the same focus/click explanations on every web list. */
export function ListEvidenceSummary({
  definitions,
  metrics,
  failed = false,
}: {
  definitions: readonly MetricDefinition[];
  metrics: Readonly<Record<string, ListGroupMetric>> | undefined;
  failed?: boolean;
}) {
  if (definitions.length === 0) return null;
  return (
    <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1 text-xs">
      {definitions
        .filter((metric) => metric.summary)
        .map((metric) => (
          <span
            key={metric.key}
            data-list-metric={metric.key}
            className="inline-flex items-baseline gap-1 whitespace-nowrap"
          >
            <span className="text-muted-foreground">{metric.label}</span>
            <span className="text-foreground">
              {metrics === undefined && !failed ? (
                "…"
              ) : (
                <ListMetricValue
                  value={metrics?.[metric.key]}
                  format={metric.format}
                />
              )}
            </span>
          </span>
        ))}
      <Popover>
        <PopoverTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Explain these totals"
            />
          }
        >
          <InfoIcon aria-hidden="true" />
        </PopoverTrigger>
        <PopoverContent
          align="end"
          className="max-h-[70dvh] w-80 max-w-[calc(100vw-2rem)] space-y-3 overflow-y-auto"
        >
          <p className="text-sm font-medium">Contribution details</p>
          {definitions.map((metric) => {
            const value = metrics?.[metric.key];
            return (
              <div key={metric.key} className="space-y-1">
                <div className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="font-medium">{metric.label}</span>
                  <ListMetricValue value={value} format={metric.format} />
                </div>
                <p className="text-xs text-muted-foreground">
                  {metric.description}
                </p>
                {value && (
                  <p className="text-xs text-muted-foreground">
                    {formatCount(value.presentCount)} of{" "}
                    {formatCount(value.totalCount)} {metric.unit.toLowerCase()}{" "}
                    have a known amount.
                  </p>
                )}
              </div>
            );
          })}
          <p className="text-xs text-muted-foreground">
            Totals count each contribution once in their scope. Overlapping
            sections can repeat contributions; adding sections can exceed the
            overall total.
          </p>
        </PopoverContent>
      </Popover>
    </div>
  );
}
