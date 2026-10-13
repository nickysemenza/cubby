import type { AiUsageEntry, AiUsageSummaryRow } from "@cubby/schemas/ai";

import {
  formatAiCost,
  formatAiCostSubtotal,
  formatExactCurrency,
} from "~/lib/number-format";
export { formatAiCost, formatAiCostSubtotal } from "~/lib/number-format";
import { CurrencyTooltip } from "~/ui/common/currency-value";
import { StackedValue } from "~/ui/common/stacked-value";

export function AiCost({
  cost,
  note,
}: {
  cost: Pick<AiUsageEntry, "standardCost" | "chargedCost"> &
    Partial<Pick<AiUsageEntry, "costEvidence">> &
    Partial<
      Pick<
        AiUsageSummaryRow,
        | "standardUnpricedCount"
        | "chargedUnpricedCount"
        | "count"
        | "billingReasons"
        | "standardComplete"
        | "chargedComplete"
      >
    >;
  note?: string;
}) {
  const charged =
    cost.chargedUnpricedCount == null
      ? formatAiCost(cost.chargedCost)
      : formatAiCostSubtotal(
          cost.chargedCost ?? 0,
          cost.chargedUnpricedCount,
          cost.count,
          cost.chargedComplete,
        );
  const standard =
    cost.standardUnpricedCount == null
      ? formatAiCost(cost.standardCost)
      : formatAiCostSubtotal(
          cost.standardCost ?? 0,
          cost.standardUnpricedCount,
          cost.count,
          cost.standardComplete,
        );
  const evidence = cost.costEvidence;
  const reasons = {
    standard: "Standard billing",
    plan: "Plan covered",
    cache: "Cached response",
    discount: "Discount applied",
    local: "On device",
    unknown: "Billing reason unknown",
  };
  const reason = evidence
    ? reasons[evidence.billingReason]
    : cost.billingReasons
        ?.filter((value) => value !== "standard")
        .map((value) => reasons[value])
        .join(" · ") || null;
  const provenance = [
    evidence?.charged?.source
      ? `Charge: ${evidence.charged.source.replaceAll("_", " ")}${evidence.charged.pricingSource ? ` (${evidence.charged.pricingSource})` : ""}`
      : null,
    evidence?.standard?.source
      ? `Standard price: ${evidence.standard.source.replaceAll("_", " ")}${evidence.standard.pricingSource ? ` (${evidence.standard.pricingSource})` : ""}`
      : null,
    reason,
    note,
  ]
    .filter(Boolean)
    .join(". ");
  const primary = `${charged} ${evidence?.charged?.source === "estimate" && evidence.billingReason === "standard" ? "estimated charge" : "charged"}`;
  const secondary = `${standard} standard${evidence?.standard?.source === "reconstructed" ? " (current-rate estimate)" : evidence?.standard?.source === "estimate" ? " (estimate)" : ""}${reason && evidence?.billingReason !== "standard" ? ` · ${reason}` : ""}`;
  const fullCharged =
    cost.chargedCost == null
      ? charged
      : charged.replace(
          formatAiCost(cost.chargedCost),
          formatExactCurrency(cost.chargedCost),
        );
  const fullStandard =
    cost.standardCost == null
      ? standard
      : standard.replace(
          formatAiCost(cost.standardCost),
          formatExactCurrency(cost.standardCost),
        );
  return (
    <CurrencyTooltip
      label={`${primary}. ${secondary}. Full amounts and pricing evidence`}
      className="block min-w-0"
      details={
        <>
          <div>Charged: {fullCharged}</div>
          <div>Standard: {fullStandard}</div>
          {provenance && <div>{provenance}</div>}
        </>
      }
    >
      <StackedValue
        primary={primary}
        secondary={secondary}
        primarySpillText={
          cost.chargedCost !== 0 && fullCharged !== charged
            ? primary.replace(charged, fullCharged)
            : undefined
        }
        secondarySpillText={
          cost.standardCost !== 0 && fullStandard !== standard
            ? secondary.replace(standard, fullStandard)
            : undefined
        }
      />
    </CurrencyTooltip>
  );
}
