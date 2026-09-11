import {
  fetchVendorLogoInput,
  mergeVendorsInput,
  mergeVendorsOut,
  vendorOptionsOut,
  vendorOut,
} from "@cubby/schemas/vendor";
import { z } from "zod";

import { defineContract, mutation, query } from "~/contracts/define";

export const vendorContract = defineContract("vendor", {
  options: query({
    input: z.null(),
    output: vendorOptionsOut,
  }),
  merge: mutation({
    input: mergeVendorsInput,
    output: mergeVendorsOut,
  }),
  fetchLogo: mutation({
    input: fetchVendorLogoInput,
    output: vendorOut,
  }),
});
