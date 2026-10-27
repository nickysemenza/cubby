import type { EntityFieldEnvelopeRead } from "@cubby/schemas/entity-field-envelopes";
import { fieldValueOf } from "@cubby/schemas/field-envelope";

import { formatCurrency } from "~/lib/number-format";
import { formatPricingCountsSummary } from "~/lib/pricing-counts";
import { FieldRecordValue } from "~/ui/derived/record-value";
import { Description } from "~/ui/primitives/description";
import { NoneValue } from "~/ui/primitives/none-value";

type Variant = "compact" | "full";

interface InventoryValuationSummaryProps {
  /** The canonical rollup retains missing results and refresh diagnostics. */
  valuation: EntityFieldEnvelopeRead<"location", "list">["fields"]["valuation"];
  variant?: Variant;
  /** Hide the pricing status note (e.g., "no pricing for 2"). */
  hidePricingStatus?: boolean;
  className?: string;
}

export function InventoryValuationSummary({
  valuation,
  variant = "compact",
  hidePricingStatus = false,
  className,
}: InventoryValuationSummaryProps) {
  const effectiveValuation = fieldValueOf(valuation);
  const pricingSummary = effectiveValuation
    ? formatPricingCountsSummary(effectiveValuation.direct)
    : null;
  const value = (
    <FieldRecordValue record={{ fields: { valuation } }} field="valuation">
      {effectiveValuation === null ? (
        <NoneValue />
      ) : (
        formatCurrency(effectiveValuation.directValuation)
      )}
    </FieldRecordValue>
  );

  if (variant === "compact") {
    return (
      <div className={className}>
        <Description as="div" size="xs">
          {value}
          {!hidePricingStatus && pricingSummary && (
            <span className="ml-1">({pricingSummary})</span>
          )}
        </Description>
      </div>
    );
  }

  return (
    <div className={className}>
      <div className="text-lg font-semibold">{value}</div>
      {!hidePricingStatus && pricingSummary && (
        <Description as="div" size="xs">
          {pricingSummary}
        </Description>
      )}
    </div>
  );
}
