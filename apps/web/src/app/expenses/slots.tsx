import { useState } from "react";

import { VerbButton } from "~/app/_components/actions/action-verb-ui";
import type { DetailSlotComponent } from "~/app/_components/entity-detail/detail-slots";
import { Row, Stack } from "~/components/layout";
import { Description } from "~/components/ui/description";

import { ExpensePurchaseSection } from "./expense-purchase-section";
import { ReceiveExpenseDialog } from "./receive-expense-dialog";
import { SplitExpenseDialog } from "./split-expense-dialog";

/**
 * How this line settles: the purchase it belongs to (and its sibling lines),
 * splitting it into parts filed under that purchase, and receiving what it
 * bought into inventory. Receiving is deliberately a separate, explicit act —
 * linking a product records what was bought, it never moves inventory on its
 * own (README tenet: inventory never auto-decrements).
 */
export const ExpenseSettlement: DetailSlotComponent<"expense"> = ({
  record: expense,
}) => {
  const [splitOpen, setSplitOpen] = useState(false);
  const [receiveOpen, setReceiveOpen] = useState(false);
  return (
    <Stack gap="md">
      <Row gap="sm" wrap>
        <VerbButton
          verb="split"
          disabled={!expense.purchaseId}
          disabledReason="Record this expense's vendor first — a split files its parts under the same purchase."
          onClick={() => setSplitOpen(true)}
        />
        <VerbButton
          verb="receive"
          disabled={!expense.productId}
          disabledReason="Link a product first — receiving needs something to put on a shelf."
          onClick={() => setReceiveOpen(true)}
        />
      </Row>
      {expense.purchaseId ? (
        <ExpensePurchaseSection expense={expense} />
      ) : (
        <Description size="xs">
          No purchase recorded — this line stands alone until a vendor order
          claims it.
        </Description>
      )}
      {expense.purchaseId && (
        <SplitExpenseDialog
          open={splitOpen}
          onOpenChange={setSplitOpen}
          expense={expense}
          purchaseShortcode={expense.purchaseId}
        />
      )}
      {expense.productId && (
        <ReceiveExpenseDialog
          open={receiveOpen}
          onOpenChange={setReceiveOpen}
          productId={expense.productId}
          expenseName={expense.name}
          purchaseId={expense.purchaseId}
        />
      )}
    </Stack>
  );
};
