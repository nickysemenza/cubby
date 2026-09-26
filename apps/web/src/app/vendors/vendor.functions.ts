import { vendorContract } from "~/contracts/vendor.contract";
import { ripple } from "~/integrations/tanstack-query/cache-tags";
import { defineOperationDomain } from "~/integrations/tanstack-query/operation-catalog";

export const vendor = defineOperationDomain(vendorContract, {
  merge: { invalidates: ripple.vendorMerge },
  fetchLogo: { invalidates: ripple.vendorLogo },
});
