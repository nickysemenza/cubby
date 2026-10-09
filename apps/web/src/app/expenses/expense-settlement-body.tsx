import type { DetailSlotComponent } from "~/entity/entity-detail/detail-slots";
import { EntityReportSlot } from "~/entity/entity-detail/report-slot";
import { Description } from "~/ui/primitives/description";

import { ExpensePurchaseSection } from "./expense-purchase-section";

/**
 * How this line settles: the purchase it belongs to and its sibling lines (drawn with thumbnails
 * by the shared entity link), and the verbs that act on the line. The total line under the
 * siblings, the no-purchase text and each verb's availability are the report's; nothing is
 * summed here.
 */
export const ExpenseSettlement: DetailSlotComponent<"expense"> = ({
  record: expense,
}) => (
  <EntityReportSlot
    slot="expense.settlement"
    id={expense.id}
    record={expense}
    entity="expense"
    recordsList={(block) =>
      expense.purchaseId ? (
        <ExpensePurchaseSection
          expense={expense}
          summaryLine={block.footer ?? null}
        />
      ) : (
        <Description size="xs">{block.empty}</Description>
      )
    }
  />
);
