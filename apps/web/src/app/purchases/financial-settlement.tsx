import type { FinancialTransactionOut } from "@cubby/schemas/financial-transaction";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import type { PurchaseOut } from "@cubby/schemas/purchase";
import { useState } from "react";

import {
  captureRequest,
  financialTransactionEditRequest,
} from "~/entity/editing/editor-requests";
import {
  EntityEditDialog,
  type EntityEditDialogRequest,
} from "~/entity/editing/entity-edit-dialog";
import { entityFieldModel } from "~/entity/entity-model";
import { fieldEnumOptions } from "~/entity/enum-field-display";
import { formatFieldProvenance } from "~/entity/field-provenance";
import { formatCurrency } from "~/lib/utils";
import { TableCellWorkbench } from "~/ui/data-table/table-cell-workbench";
import { Row, Stack } from "~/ui/layout";
import { Description } from "~/ui/primitives/description";
import { EnumPill } from "~/ui/primitives/enum-pill";

import { LinkedTransactions } from "../finance/linked-transactions";
import { MatchStatementButton } from "./match-statement";

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
// Read on render: the purchase model registers with the route, after import.
function settlementProvenanceDescription() {
  const settlementField = entityFieldModel("purchase").fields.find(
    (field) => field.key === "financialReconciliation",
  );
  if (!settlementField?.provenance) {
    throw new Error("Purchase financial settlement requires provenance");
  }
  return formatFieldProvenance(settlementField.provenance);
}

export function FinancialSettlementStatus({
  purchase,
}: {
  purchase: FinancialPurchase;
}) {
  const settlement = purchase.financialReconciliation;
  const option = fieldEnumOptions("purchase", "financialReconciliation").find(
    (candidate) => candidate.value === settlement.status,
  );
  return (
    <EnumPill color={option?.color ?? "var(--slate)"}>
      {option?.label ?? settlement.status} · {settlement.transactionCount}
    </EnumPill>
  );
}
function FinancialSettlement({
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
      <MatchStatementButton purchaseId={purchase.id} />
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
        description={settlementProvenanceDescription()}
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
