import type { PurchaseOut } from "@cubby/schemas/purchase";
import { Row, Stack } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import { Description } from "~/components/ui/description";
import { formatCurrency } from "~/lib/utils";
import { LinkedTransactions } from "../finance/linked-transactions";

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
const tone = {
  unknown: "slate",
  pending: "warning",
  match: "positive",
  mismatch: "destructive",
} as const;
export function FinancialSettlementBadge({
  purchase,
}: {
  purchase: FinancialPurchase;
}) {
  const settlement = purchase.financialReconciliation;
  return (
    <Badge variant={tone[settlement.status]}>
      {settlement.status} · {settlement.transactionCount}
    </Badge>
  );
}
export function FinancialSettlement({
  purchase,
}: {
  purchase: FinancialPurchase;
}) {
  const settlement = purchase.financialReconciliation;
  return (
    <Stack gap="sm">
      <Row align="center" justify="between">
        <FinancialSettlementBadge purchase={purchase} />
        <span className="font-mono text-sm tabular-nums">
          {settlement.transactionCount} entries
        </span>
      </Row>
      <Row align="center" justify="between">
        <span className="text-muted-foreground text-sm">Posted</span>
        <span className="font-mono tabular-nums">
          {formatCurrency(settlement.postedTotal)}
        </span>
      </Row>
      <Row align="center" justify="between">
        <span className="text-muted-foreground text-sm">Projected</span>
        <span className="font-mono tabular-nums">
          {formatCurrency(settlement.projectedTotal)}
        </span>
      </Row>
      {settlement.delta != null && (
        <Row align="center" justify="between">
          <span className="text-muted-foreground text-sm">Delta</span>
          <span className="font-mono tabular-nums">
            {formatCurrency(settlement.delta)}
          </span>
        </Row>
      )}
      <Description size="xs">
        Settlement amounts are evidence only. Expense lines remain Cubby&apos;s
        only source of spend.
      </Description>
      <LinkedTransactions purchaseId={purchase.id} />
    </Stack>
  );
}
