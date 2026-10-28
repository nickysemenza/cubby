import { vendorOut } from "@cubby/schemas/entities/vendor";
import {
  fetchVendorLogoInput,
  mergeVendorsInput,
  mergeVendorsOut,
  vendorCoverageInput,
  vendorCoverageOut,
} from "@cubby/schemas/vendor";

import { defineContract, mutation, query } from "~/contracts/define";

export const vendorContract = defineContract(
  "vendor",
  {
    merge: mutation({
      exposure: "view",
      note: "entity.merge with entity vendor",
      input: mergeVendorsInput,
      output: mergeVendorsOut,
      invalidates: ["vendorMerge"],
    }),
    fetchLogo: mutation({
      note: "Favicon fetch for a vendor logo",
      description:
        "Fetch a representative logo from the Vendor’s public website and store it on the Vendor. Review the resolved site before calling; the fetched image may be an external match.",
      openWorld: true,
      command: {
        label: "Fetch or refresh logo",
        confirmation: null,
        success: "Vendor logo saved",
        affectedEntities: ["vendor", "image"],
      },
      input: fetchVendorLogoInput,
      output: vendorOut,
      invalidates: ["vendorLogo"],
    }),
    /** Identity, latest purchase date, and order ids in a window (MCP `imports_read`). */
    coverage: query({
      description:
        "Vendor identity, its latest live purchase date overall, and sorted unique non-null order IDs from an inclusive date range.",
      input: vendorCoverageInput,
      output: vendorCoverageOut,
    }),
  },
  { exposure: "capability", mcpToolGroup: "imports_read" },
);
