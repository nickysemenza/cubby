import { VendorClassification } from "~/app/finance/spending-classification-review";
import { defineDetailHooks } from "~/entity/entity-detail/detail-hooks";
import { reportSlotFill } from "~/entity/entity-detail/report-slot";

export const vendorDetailHooks = defineDetailHooks("vendor", {
  slots: {
    "spending-classification": { component: VendorClassification },
    "order-mail": reportSlotFill<"vendor">("vendor.order-mail"),
  },
});
