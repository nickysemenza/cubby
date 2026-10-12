import {
  fetchVendorLogoInput,
  mergeVendorsInput,
  mergeVendorsOut,
  vendorCoverageInput,
  vendorCoverageOut,
  vendorOut,
} from "@cubby/schemas/vendor";

import { defineContract, mutation, query } from "~/contracts/define";

export const vendorContract = defineContract("vendor", {
  merge: mutation({
    mcp: {
      omit: "kernel_alternative",
      kernel: ["merge"],
      note: "entity.merge with entity vendor",
    },
    input: mergeVendorsInput,
    output: mergeVendorsOut,
    invalidates: ["vendorMerge"],
  }),
  fetchLogo: mutation({
    mcp: {
      omit: "operator_maintenance",
      note: "Favicon fetch for a vendor logo",
    },
    input: fetchVendorLogoInput,
    output: vendorOut,
    invalidates: ["vendorLogo"],
  }),
  /** Identity, latest purchase date, and order ids in a window (MCP `imports_read`). */
  coverage: query({
    http: false,
    input: vendorCoverageInput,
    output: vendorCoverageOut,
  }),
});
