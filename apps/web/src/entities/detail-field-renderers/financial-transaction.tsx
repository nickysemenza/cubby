import { TableLink } from "~/app/_components/table/TableLink";
import { PossibleVendor } from "~/app/finance/possible-vendor";
import { Row, Stack } from "~/components/layout";
import { EntityFilterLink } from "~/components/ui/entity-filter-link";
import { NoneValue } from "~/components/ui/none-value";
import { entities, entityDetailParams } from "~/entities/entities";
import { formatCurrency } from "~/lib/utils";

import type { EntityDetailFieldRenderers } from "./index";

export const financialTransactionDetailFields = {
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
        <NoneValue />
      ) : (
        <Stack gap="tight">
          {transaction.allocations.map((allocation) => (
            <Row key={allocation.purchaseId} justify="between" gap="sm">
              <Row align="center" gap="tight">
                <TableLink
                  to={entities.purchase.routes.detail}
                  params={entityDetailParams(allocation.purchaseId)}
                  variant="mono"
                >
                  {allocation.purchaseId}
                </TableLink>
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
