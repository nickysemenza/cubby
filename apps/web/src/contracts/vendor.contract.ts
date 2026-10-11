import {
  orderMailImportInput,
  orderMailImportOut,
  orderMailImportSelectedInput,
  orderMailDecisionInput,
  orderMailDecisionOut,
  purchaseOrderMailOut,
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
  decideOrderMail: mutation({
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
