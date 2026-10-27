import { fieldValueOf } from "@cubby/schemas/field-envelope";

import {
  EntityRefLink,
  EntityFilterLink,
} from "~/entity/components/entity-ref-link";
import { FinancialBookingCorrectionReview } from "~/features/finance/financial-booking-correction-review";
import { FinancialBookingReview } from "~/features/finance/financial-booking-review";
import { PossibleVendor } from "~/features/finance/possible-vendor";
import { formatCurrency } from "~/lib/number-format";
import { Row, Stack } from "~/ui/layout";

import type { EntityDetailFieldRenderers } from "../../entity/display/detail-field-renderers/index";
import { renderSpendingCategorySummary } from "../../entity/display/detail-field-renderers/spending-category-summary";

export const financialTransactionDetailFields = {
  "spending-category-summary": (transaction) => {
    const effectiveTransactionSpendingCategorySummary = fieldValueOf(
      transaction.fields.spendingCategorySummary,
    );
    return {
      value: renderSpendingCategorySummary(
        effectiveTransactionSpendingCategorySummary,
        true,
      ),
    };
  },
  "financial-transaction-vendor-inference": (transaction) => {
    const effectiveTransactionVendorInference = fieldValueOf(
      transaction.fields.vendorInference,
    );
    return {
      value:
        effectiveTransactionVendorInference?.status === "suggested" ||
        effectiveTransactionVendorInference?.status === "ambiguous" ? (
          <PossibleVendor inference={effectiveTransactionVendorInference} />
        ) : undefined,
    };
  },
  // One card line can settle several Purchases, so this shows the
  // allocation set rather than the single derived mirror — which is NULL
  // precisely when the answer is interesting.
  "financial-transaction-allocations": (transaction) => ({
    label: transaction.allocations.length > 1 ? "Settles" : "Purchase",
    value:
      transaction.allocations.length === 0 ? (
        <FinancialBookingReview transaction={transaction} />
      ) : (
        <Stack gap="tight">
          <FinancialBookingCorrectionReview transaction={transaction} />
          {transaction.allocations.map((allocation) => (
            <Row key={allocation.purchaseId} justify="between" gap="sm">
              <Row align="center" gap="tight">
                <EntityRefLink entity="purchase" id={allocation.purchaseId} />
                <EntityFilterLink
                  to="/financial-transactions"
                  search={{ purchaseId: allocation.purchaseId }}
                  label={`Show all transactions allocated to ${allocation.purchaseId}`}
                />
              </Row>
              {transaction.allocations.length > 1 ? (
                <span className="font-mono tabular-nums">
                  {formatCurrency(allocation.amount)}
                </span>
              ) : null}
            </Row>
          ))}
        </Stack>
      ),
  }),
} satisfies EntityDetailFieldRenderers<"financialTransaction">;
