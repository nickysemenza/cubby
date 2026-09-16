import type { PurchaseProductOut } from "@cubby/schemas/purchase";
import { useQuery } from "@tanstack/react-query";
import { Link2 } from "lucide-react";
import { useState } from "react";

import type { DetailSlotComponent } from "~/app/_components/entity-detail/detail-slots";
import { RelationshipSummaryTable } from "~/app/_components/relationships/relationship-summary-table";
import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { NoneValue } from "~/components/ui/none-value";
import { formatCurrency } from "~/lib/utils";

import { FinancialSettlement } from "./financial-settlement";
import { LinkExpensesDialog } from "./link-expenses-dialog";
import { LinkProductsDialog } from "./link-products-dialog";
import {
  purchaseReconciliationStatus,
  ReconciliationBadge,
  ReconciliationNote,
} from "./purchase-reconciliation";
import { purchase as purchaseOperations } from "./purchase.functions";

const EMPTY_PURCHASE_PRODUCTS: PurchaseProductOut[] = [];

/** Spend on this purchase's lines, rolled up by the project they belong to. */
export const PurchaseProjectAllocation: DetailSlotComponent<"purchase"> = ({
  record: purchase,
}) => (
  <RelationshipSummaryTable
    relationKey="purchase.projects"
    sourceId={purchase.id}
    columns={["target", "expenses", "unpriced", "netSpend"]}
    defaultSort={{ field: "netSpend", direction: "desc" }}
    emptyCopy="No expenses on this purchase have been assigned to projects yet."
    nullLabel="Unassigned"
    expenseHref={(target) =>
      `/expenses?purchaseId=${encodeURIComponent(purchase.id)}&project=${encodeURIComponent(target?.id ?? "__none__")}`
    }
  />
);

/**
 * What the paperwork said against what the lines add up to. Stated totals
 * are a cue, never spend: the two are compared, not reconciled into each
 * other. The attach dialogs live here because they change what this
 * comparison covers.
 */
export const PurchaseReconciliation: DetailSlotComponent<"purchase"> = ({
  record: purchase,
}) => {
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkProductsOpen, setLinkProductsOpen] = useState(false);
  const productsQuery = useQuery(
    purchaseOperations.products.queryOptions({ purchaseId: purchase.id }),
  );
  const linkedProducts = productsQuery.data ?? EMPTY_PURCHASE_PRODUCTS;
  // Explicitly-linked products only: the picker hides what is already
  // attached, and `purchase.products` also returns products derived from
  // this order's itemized expenses — taking every row would hide exactly
  // the products still worth linking.
  const attachedProductIds = new Set(
    linkedProducts
      .filter((item) => item.linkAttachedAt !== null)
      .map((item) => item.productId),
  );
  const status = purchaseReconciliationStatus(purchase);
  return (
    <Stack gap="sm">
      <Row align="center" justify="between" gap="sm">
        <span className="text-sm text-muted-foreground">Stated</span>
        <span className="font-mono text-sm tabular-nums">
          {purchase.statedTotal != null ? (
            formatCurrency(purchase.statedTotal)
          ) : (
            <NoneValue />
          )}
        </span>
      </Row>
      <Row align="center" justify="between" gap="sm">
        <span className="text-sm text-muted-foreground">Expenses</span>
        <span className="font-mono text-sm tabular-nums">
          {formatCurrency(purchase.expenseTotal)}
        </span>
      </Row>
      <Row
        align="center"
        justify="between"
        gap="sm"
        className="border-t border-border pt-2"
      >
        <ReconciliationBadge purchase={purchase} />
      </Row>
      <ReconciliationNote status={status} />
      <Row gap="sm" wrap>
        <Button variant="outline" size="sm" onClick={() => setLinkOpen(true)}>
          <Link2 />
          Attach existing expenses
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setLinkProductsOpen(true)}
        >
          <Link2 />
          Attach products
        </Button>
      </Row>
      <LinkExpensesDialog
        open={linkOpen}
        onOpenChange={setLinkOpen}
        purchase={purchase}
      />
      <LinkProductsDialog
        open={linkProductsOpen}
        onOpenChange={setLinkProductsOpen}
        purchase={purchase}
        attachedIds={attachedProductIds}
      />
    </Stack>
  );
};

export const PurchaseFinancialSettlement: DetailSlotComponent<"purchase"> = ({
  record: purchase,
}) => <FinancialSettlement purchase={purchase} />;
