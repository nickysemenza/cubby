import type { DetailSlotComponent } from "~/entity/entity-detail/detail-slots";
import { EntityReportSlot } from "~/entity/entity-detail/report-slot";

/** Import runs are linked through their AuditLog rows; the server's report lists them. */
export const Runs: DetailSlotComponent<"purchase"> = ({ record: purchase }) => (
  <EntityReportSlot slot="purchase.runs" id={purchase.id} record={purchase} />
);

/**
 * What the paperwork said against what the lines add up to. Stated totals are a cue, never spend:
 * the stated and expense figures, the verdict (the shared `reconciliation`) and its note are the
 * report's. The attach verbs sit here because they change what this comparison covers.
 */
export const PurchaseReconciliation: DetailSlotComponent<"purchase"> = ({
  record: purchase,
}) => (
  <EntityReportSlot
    slot="purchase.reconciliation"
    id={purchase.id}
    record={purchase}
    entity="purchase"
  />
);
