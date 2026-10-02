import {
  orderMailImportInput,
  orderMailImportOut,
  orderMailDecisionInput,
  orderMailDecisionOut,
  purchaseOrderMailOut,
  vendorOrderMailInput,
  vendorSearchMailInput,
  vendorSearchMailOut,
  vendorSearchMailStatusInput,
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
  searchOrderMail: mutation({
    input: vendorSearchMailInput,
    output: vendorSearchMailOut,
    invalidates: ["vendor"],
  }),
  orderMailSearchStatus: query({
    input: vendorSearchMailStatusInput,
    output: vendorSearchMailOut.nullable(),
    cache: { tags: [] },
  }),
  importOrderMail: mutation({
    input: orderMailImportInput,
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
    input: mergeVendorsInput,
    output: mergeVendorsOut,
    invalidates: ["vendorMerge"],
  }),
  fetchLogo: mutation({
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
