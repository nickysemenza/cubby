import { PurchaseFinancialSettlement } from "~/app/purchases/financial-settlement-body";
import { PurchaseProjectAllocation } from "~/app/purchases/project-allocation-table";
import { PurchaseReceiving } from "~/app/purchases/receive-purchase-section";
import {
  LinkExpensesAction,
  LinkProductsAction,
  MatchStatementAction,
} from "~/app/purchases/section-actions";
import {
  PurchaseReconciliation,
  Runs,
  ValidatePurchaseAction,
} from "~/app/purchases/slots";
import {
  defineDetailHooks,
  type DetailSlotComponent,
} from "~/entity/entity-detail/detail-hooks";
import {
  ReportDetailActions,
  reportSlotFill,
} from "~/entity/entity-detail/report-slot";

const PurchaseDetailActions: DetailSlotComponent<"purchase"> = ({ record }) => (
  <>
    <ReportDetailActions
      slot="purchase.financial-settlement"
      id={record.id}
      record={record}
    />
    <ReportDetailActions
      slot="purchase.reconciliation"
      id={record.id}
      record={record}
    />
  </>
);

export const purchaseDetailHooks = defineDetailHooks("purchase", {
  slots: {
    "order-mail": reportSlotFill<"purchase">("purchase.order-mail"),
    runs: { component: Runs },
    "project-allocation": { component: PurchaseProjectAllocation },
    receiving: { component: PurchaseReceiving },
    reconciliation: { component: PurchaseReconciliation },
    "financial-settlement": { component: PurchaseFinancialSettlement },
  },
  headerActions: PurchaseDetailActions,
  sectionActions: {
    matchStatement: MatchStatementAction,
    linkExpenses: LinkExpensesAction,
    linkProducts: LinkProductsAction,
  },
  collectionActions: { validatePurchase: ValidatePurchaseAction },
});
