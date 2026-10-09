import {
  chargeRunStartInput,
  chargeRunStartOut,
  orderMailImportInput,
  orderMailImportOut,
  orderMailImportSelectedInput,
  orderMailDecisionInput,
  orderMailDecisionOut,
  purchaseOrderMailOut,
  vendorChargeHuntsInput,
  vendorChargeHuntsOut,
  vendorOrderMailInput,
} from "@cubby/schemas/order-mail-review";
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
  orderMail: query({
    mcp: {
      omit: "deferred_capability",
      todo: "Deferred MCP agent capabilities",
    },
    native:
      "Review member-scoped order email on Vendor and Vendor account detail",
    input: vendorOrderMailInput,
    output: purchaseOrderMailOut,
    cache: { tags: [["vendor"]] },
  }),
  importOrderMail: mutation({
    native:
      "Research a reviewed retained original through the shared Run runtime",
    mcp: {
      omit: "deferred_capability",
      todo: "Deferred MCP agent capabilities",
    },
    input: orderMailImportInput,
    output: orderMailImportOut,
    invalidates: ["vendor", "runOnly"],
  }),
  importSelectedOrderMail: mutation({
    mcp: {
      omit: "deferred_capability",
      todo: "Deferred MCP agent capabilities",
    },
    input: orderMailImportSelectedInput,
    output: orderMailImportOut,
    invalidates: ["vendor"],
  }),
  chargeHunts: query({
    input: vendorChargeHuntsInput,
    output: vendorChargeHuntsOut,
    cache: { tags: [["vendor"], ["run"]] },
  }),
  startChargeRun: mutation({
    native: "Start one browser run for the selected statement charges",
    input: chargeRunStartInput,
    output: chargeRunStartOut,
    invalidates: ["vendor", "runOnly"],
  }),
  decideOrderMail: mutation({
    mcp: {
      omit: "human_approval",
      note: "A person confirms or dismisses an order email's Purchase match",
    },
    native: "Confirm or dismiss an order email Purchase match in Apple apps",
    input: orderMailDecisionInput,
    output: orderMailDecisionOut,
    invalidates: ["vendor"],
  }),
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
