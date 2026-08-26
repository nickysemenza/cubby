import {
  fetchVendorLogoInput,
  mergeVendorsInput,
  mergeVendorsOut,
  vendorOptionsOut,
  vendorOut,
} from "@cubby/schemas/vendor";
import { z } from "zod";
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
    invalidates: [["vendor", "merge"]],
  }),
  fetchLogo: mutation({
    input: fetchVendorLogoInput,
    output: vendorOut,
    invalidates: [["vendor"]],
  }),
});
