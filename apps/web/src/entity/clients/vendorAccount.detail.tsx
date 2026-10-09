import {
  SyncAccountAction,
  VendorAccountSync,
} from "~/app/vendors/account-sync";
import {
  SearchChargesAction,
  VendorAccountChargeSearch,
} from "~/app/vendors/charge-search";
import { defineDetailHooks } from "~/entity/entity-detail/detail-hooks";
import { reportSlotFill } from "~/entity/entity-detail/report-slot";

export const vendorAccountDetailHooks = defineDetailHooks("vendorAccount", {
  slots: {
    "order-mail": reportSlotFill<"vendorAccount">("vendorAccount.order-mail"),
    sync: { component: VendorAccountSync },
    "charge-search": { component: VendorAccountChargeSearch },
  },
  sectionActions: {
    syncAccount: SyncAccountAction,
    searchCharges: SearchChargesAction,
  },
});
