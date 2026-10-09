import type { DetailSlotComponent } from "~/entity/entity-detail/detail-hooks";
import { EntityReportSlot } from "~/entity/entity-detail/report-slot";

import {
  LinkedTransactions,
  type LinkedAmounts,
} from "../finance/linked-transactions";

/**
 * The transactions behind a purchase's computed settlement, in the editable ledger table (inline
 * status, date and amount edits, column menu). The status and totals, the note, the verbs and the
 * amount in each row are the report's, so the slice a split charge gave this purchase is the
 * server's wording, not one re-found here.
 */
export const PurchaseFinancialSettlement: DetailSlotComponent<"purchase"> = ({
  record: purchase,
}) => (
  <EntityReportSlot
    slot="purchase.financial-settlement"
    id={purchase.id}
    record={purchase}
    entity="purchase"
    recordsList={(block) => {
      const amounts: LinkedAmounts = new Map(
        block.rows.flatMap((row) =>
          row.key !== undefined && row.trailing
            ? [[row.key, row.trailing] as const]
            : [],
        ),
      );
      return <LinkedTransactions purchaseId={purchase.id} amounts={amounts} />;
    }}
  />
);
