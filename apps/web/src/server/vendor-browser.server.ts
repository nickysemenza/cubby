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
  searchOrderMail: async (context, input) => {
    const { startVendorMailSearchJob } =
      await import("~/server/purchase-import/gmail/search-job");
    return startVendorMailSearchJob(context.db, input, context.actorContext);
  },
  orderMailSearchStatus: async (context, input) => {
    const { latestVendorMailSearchJob } =
      await import("~/server/purchase-import/gmail/search-job");
    return latestVendorMailSearchJob(
      context.db,
      input.vendorId,
      context.actorContext,
    );
  },
  decideOrderMail: (context, input) =>
    decideOrderMailCandidate(context.db, input, context.actorContext),
  merge: (context, input) => mergeVendorsWorkflow(context, input),
  fetchLogo: (context, input) => fetchVendorLogoWorkflow(context, input),
});
