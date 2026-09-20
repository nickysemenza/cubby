import { entityFieldModels } from "@cubby/schemas/entity-fields";
import type { FinancialTransactionOut } from "@cubby/schemas/financial-transaction";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import type { PurchaseOut } from "@cubby/schemas/purchase";
import { useState } from "react";

import { TableCellWorkbench } from "~/app/_components/data-table/table-cell-workbench";
import { Row, Stack } from "~/components/layout";
import { Description } from "~/components/ui/description";
import { EnumPill } from "~/components/ui/enum-pill";
import {
  captureRequest,
  financialTransactionEditRequest,
} from "~/entities/editing/editor-requests";
import {
  EntityEditDialog,
  type EntityEditDialogRequest,
} from "~/entities/editing/entity-edit-dialog";
import { formatFieldProvenance } from "~/entities/field-provenance";
import { formatCurrency } from "~/lib/utils";

import { LinkedTransactions } from "../finance/linked-transactions";
import { financialSettlementOptions } from "./purchase-options";

type FinancialPurchase = PurchaseOut & {
  financialReconciliation: {
    status: "unknown" | "pending" | "match" | "mismatch";
    transactionCount: number;
    postedTransactionCount: number;
    outstandingTransactionCount: number;
    postedTotal: number;
    projectedTotal: number;
    postedRefundTotal: number;
    delta: number | null;
  };
};
const settlementField = entityFieldModels.purchase.fields.find(
  (field) => field.key === "financialReconciliation",
);
if (!settlementField?.provenance) {
  throw new Error("Purchase financial settlement requires provenance");
}
const settlementProvenanceDescription = formatFieldProvenance(
  settlementField.provenance,
);

export function FinancialSettlementStatus({
  purchase,
}: {
  purchase: FinancialPurchase;
}) {
  const settlement = purchase.financialReconciliation;
  const option = financialSettlementOptions.find(
    (candidate) => candidate.value === settlement.status,
  );
  return (
    <EnumPill color={option?.color ?? "var(--slate)"}>
      {option?.label ?? settlement.status} · {settlement.transactionCount}
    </EnumPill>
  );
}
export function FinancialSettlement({
  purchase,
  onAddTransaction,
  onEditTransaction,
}: {
  purchase: FinancialPurchase;
  onAddTransaction?: () => void;
  onEditTransaction?: (transaction: FinancialTransactionOut) => void;
}) {
  const settlement = purchase.financialReconciliation;
  return (
    <Stack gap="sm">
      <Row align="center" justify="between">
        <FinancialSettlementStatus purchase={purchase} />
        <span className="font-mono text-sm tabular-nums">
          {settlement.transactionCount} entries
        </span>
      </Row>
      <Row align="center" justify="between">
        <span className="text-sm text-muted-foreground">Posted</span>
        <span className="font-mono tabular-nums">
          {formatCurrency(settlement.postedTotal)}
        </span>
      </Row>
      <Row align="center" justify="between">
        <span className="text-sm text-muted-foreground">Projected</span>
        <span className="font-mono tabular-nums">
          {formatCurrency(settlement.projectedTotal)}
        </span>
      </Row>
      {settlement.delta != null && (
        <Row align="center" justify="between">
          <span className="text-sm text-muted-foreground">Delta</span>
          <span className="font-mono tabular-nums">
            {formatCurrency(settlement.delta)}
          </span>
        </Row>
      )}
      <Description size="xs">
        Settlement amounts are evidence only. Expense lines remain Cubby&apos;s
        only source of spend.
      </Description>
      <LinkedTransactions
        purchaseId={purchase.id}
        onAddTransaction={onAddTransaction}
        onEditTransaction={onEditTransaction}
      />
    </Stack>
  );
}

export function financialTransactionCaptureRequestForPurchase(
  purchaseId: string,
): EntityEditDialogRequest<"financialTransaction"> {
  return captureRequest("financialTransaction", {
    purchaseId: parseShortcodeFor("purchase", purchaseId),
  });
}

/** Inspect and manage the transaction evidence behind a computed settlement. */
export function FinancialSettlementCell({
  purchase,
}: {
  purchase: FinancialPurchase;
}) {
  const [workbenchOpen, setWorkbenchOpen] = useState(false);
  const [dialogRequest, setDialogRequest] =
    useState<EntityEditDialogRequest<"financialTransaction"> | null>(null);

  const launch = (request: EntityEditDialogRequest<"financialTransaction">) => {
    setWorkbenchOpen(false);
    setDialogRequest(request);
  };

  return (
    <>
      <TableCellWorkbench
        title="Financial settlement"
        description={settlementProvenanceDescription}
        summary={<FinancialSettlementStatus purchase={purchase} />}
        open={workbenchOpen}
        onOpenChange={setWorkbenchOpen}
      >
        <FinancialSettlement
          purchase={purchase}
          onAddTransaction={() =>
            launch(financialTransactionCaptureRequestForPurchase(purchase.id))
          }
          onEditTransaction={(transaction) =>
            launch(financialTransactionEditRequest(transaction))
          }
        />
      </TableCellWorkbench>
      {dialogRequest ? (
        <EntityEditDialog
          open
          onOpenChange={(open) => {
            if (!open) setDialogRequest(null);
          }}
          request={dialogRequest}
          onSuccess={() => setDialogRequest(null)}
        />
      ) : null}
    </>
  );
}
