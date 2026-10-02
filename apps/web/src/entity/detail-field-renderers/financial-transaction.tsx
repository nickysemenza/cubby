import { FinancialBookingCorrectionReview } from "~/app/finance/financial-booking-correction-review";
import { FinancialBookingReview } from "~/app/finance/financial-booking-review";
import { PossibleVendor } from "~/app/finance/possible-vendor";
import { EntityRefLink } from "~/entity/components/entity-ref-link";
import { entities, entityDetailParams } from "~/entity/entities";
import { formatCurrency } from "~/lib/utils";
import { Row, Stack } from "~/ui/layout";
import { NoneValue } from "~/ui/primitives/none-value";

import type { EntityDetailFieldRenderers } from "./index";
import { renderSpendingCategorySummary } from "./spending-category-summary";

export const financialTransactionDetailFields = {
  "spending-category-summary": (transaction) => ({
    value: renderSpendingCategorySummary(
      transaction.spendingCategorySummary,
      true,
    ),
  }),
  "financial-transaction-vendor-inference": (transaction) => ({
    value:
      transaction.vendorInference?.status === "suggested" ||
      transaction.vendorInference?.status === "ambiguous" ? (
        <PossibleVendor inference={transaction.vendorInference} />
      ) : undefined,
  }),
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
                <EntityRefLink
                  variant="table"
                  to={entities.purchase.routes.detail}
                  params={entityDetailParams(allocation.purchaseId)}
                  tone="mono"
                >
                  {allocation.purchaseId}
                </EntityRefLink>
                <EntityRefLink
                  variant="filter"
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
  "financial-transaction-source-refs": (transaction) => ({
    value:
      transaction.sourceRefs.length > 0 ? (
        <span className="font-mono text-xs">
          {transaction.sourceRefs
            .map((reference) => `${reference.source}: ${reference.externalId}`)
            .join(", ")}
        </span>
      ) : (
        <NoneValue />
      ),
  }),
} satisfies EntityDetailFieldRenderers<"financialTransaction">;
