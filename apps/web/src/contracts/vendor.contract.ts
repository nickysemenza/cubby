import { vendorOut } from "@cubby/schemas/entities/vendor";
import {
  fetchVendorLogoInput,
  mergeVendorsInput,
  mergeVendorsOut,
  setVendorSenderInput,
  setVendorSenderOut,
} from "@cubby/schemas/vendor";

import { defineContract, mutation } from "~/contracts/define";

export const vendorContract = defineContract(
  "vendor",
  {
    setSender: mutation({
      exposure: "view",
      note: "Member confirmation or removal of an exact seller identity; never a domain rule",
      input: setVendorSenderInput,
      output: setVendorSenderOut,
      invalidates: ["vendor"],
    }),
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
  },
  { exposure: "capability", mcpToolGroup: "imports" },
);
