import {
  fetchVendorLogoInput,
  mergeVendorsInput,
  mergeVendorsOut,
  vendorOut,
} from "@cubby/schemas/vendor";

import { defineContract, mutation } from "~/contracts/define";

export const vendorContract = defineContract("vendor", {
  merge: mutation({
    input: mergeVendorsInput,
    output: mergeVendorsOut,
  }),
  fetchLogo: mutation({
    input: fetchVendorLogoInput,
    output: vendorOut,
  }),
});
