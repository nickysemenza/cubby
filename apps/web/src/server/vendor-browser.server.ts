import { vendorContract } from "~/contracts/vendor.contract";
import { implementOperationDomain } from "~/server/operation-domain.server";
import {
  decideOrderMailCandidate,
  listVendorOrderMail,
} from "~/server/purchase-import/gmail/review";
import {
  fetchVendorLogoWorkflow,
  mergeVendorsWorkflow,
} from "~/server/workflows/vendor.server";

export const vendorHandlers = implementOperationDomain(vendorContract, {
  orderMail: (context, input) => listVendorOrderMail(context.db, input),
  decideOrderMail: (context, input) =>
    decideOrderMailCandidate(context.db, input, context.actorContext),
  merge: (context, input) => mergeVendorsWorkflow(context, input),
  fetchLogo: (context, input) => fetchVendorLogoWorkflow(context, input),
});
