import {
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
});
