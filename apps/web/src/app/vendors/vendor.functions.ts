import {
  fetchVendorLogoInput,
  mergeVendorsInput,
  mergeVendorsOut,
  vendorOptionsOut,
  vendorOut,
} from "@cubby/schemas/vendor";
import { z } from "zod";

import { ripple } from "~/integrations/tanstack-query/cache-tags";
import {
  defineOperationDomain,
  mutation,
  query,
} from "~/integrations/tanstack-query/operation-catalog";

export const vendor = defineOperationDomain("vendor", {
  options: query({
    input: z.null(),
    output: vendorOptionsOut,
    tags: [["vendor", "options"]],
  }),
  merge: mutation({
    input: mergeVendorsInput,
    output: mergeVendorsOut,
    invalidates: ripple.vendorMerge,
  }),
  fetchLogo: mutation({
    input: fetchVendorLogoInput,
    output: vendorOut,
    invalidates: ripple.vendorLogo,
  }),
});
