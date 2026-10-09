import type { ExpenseOut } from "@cubby/schemas/project";
import { useQuery } from "@tanstack/react-query";
import { useState, type FC } from "react";

import { ReceiveExpenseDialog } from "~/app/expenses/receive-expense-dialog";
import { VerbButton } from "~/entity/actions/action-verb-ui";
import type { DetailSlotComponent } from "~/entity/entity-detail/detail-hooks";
import { entityListFor } from "~/entity/entity-list";
import { Row, Stack } from "~/ui/layout";
import { Description } from "~/ui/primitives/description";
import { StatusText } from "~/ui/primitives/status-text";

const PAGE_SIZE = 100;

/**
 * Receive from the Purchase: every Product line opens the same per-line dialog,
 * so the "arrived" finding's instruction is true. Importing never counted
 * these units; the dialog shows existing and possibly-duplicate stock first
 * and writes nothing until the operator confirms additional units arrived.
 */
export const PurchaseReceiving: DetailSlotComponent<"purchase"> = ({
  record: purchase,
}) => {
  const lines = useQuery(
    entityListFor("expense").queryOptions({
      filters: { purchaseId: purchase.id },
      pagination: { pageIndex: 0, pageSize: PAGE_SIZE },
    }),
  );
  const [receiving, setReceiving] = useState<ExpenseOut | null>(null);
  if (lines.isPending) return <StatusText>Loading lines…</StatusText>;
  if (lines.isError)
    return <StatusText tone="destructive">{lines.error.message}</StatusText>;
  const productLines = lines.data.items.filter((line) => line.productId);
  if (productLines.length === 0)
    return (
      <Description size="xs">
        No line on this purchase names a Product to receive.
      </Description>
    );
  return (
    <Stack gap="sm">
      <Description size="xs">
        Importing a purchase never counts stock. Receive a line only for units
        that actually arrived.
      </Description>
      {productLines.map((line) => (
        <ReceiveLine key={line.id} line={line} onReceive={setReceiving} />
      ))}
      {receiving?.productId ? (
        <ReceiveExpenseDialog
          open
          onOpenChange={(next) => {
            if (!next) setReceiving(null);
          }}
          productId={receiving.productId}
          expenseName={receiving.name}
          expenseId={receiving.id}
        />
      ) : null}
    </Stack>
  );
};

const ReceiveLine: FC<{
  line: ExpenseOut;
  onReceive: (line: ExpenseOut) => void;
}> = ({ line, onReceive }) => (
  <Row align="center" justify="between" gap="sm" wrap>
    <span className="min-w-0 text-sm">
      {line.name}
      {line.productName ? (
        <span className="text-muted-foreground"> · {line.productName}</span>
      ) : null}
    </span>
    <VerbButton verb="receive" onClick={() => onReceive(line)} />
  </Row>
);
