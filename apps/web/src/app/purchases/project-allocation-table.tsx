import type { DetailSlotComponent } from "~/entity/entity-detail/detail-slots";
import { EntityReportSlot } from "~/entity/entity-detail/report-slot";
import { RelationshipSummaryTable } from "~/entity/relationships/relationship-summary-table";

/**
 * The sortable, searchable project split of a purchase's lines. The total and note come from the
 * purchase's report; the table reads the same server summary (`purchase.projects`) the report's
 * rows do, so the groups add up to the purchase's expense total.
 */
export const PurchaseProjectAllocation: DetailSlotComponent<"purchase"> = ({
  record: purchase,
}) => (
  <EntityReportSlot
    slot="purchase.project-allocation"
    id={purchase.id}
    record={purchase}
    entity="purchase"
    recordsList={(block) => (
      <RelationshipSummaryTable
        relationKey="purchase.projects"
        sourceId={purchase.id}
        columns={["target", "items", "sharedCharges", "netSpend", "coverage"]}
        defaultSort={{ field: "netSpend", direction: "desc" }}
        emptyCopy={block.empty}
        nullLabel="Unassigned"
        expenseHref={(target) =>
          `/expenses?purchaseId=${encodeURIComponent(purchase.id)}&project=${encodeURIComponent(target?.id ?? "__none__")}`
        }
      />
    )}
  />
);
