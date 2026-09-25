import { vendorContract } from "~/contracts/vendor.contract";
import { implementOperationDomain } from "~/server/operation-domain.server";
import { vendorOptions } from "~/server/repo/vendor";
import {
  fetchVendorLogoWorkflow,
  mergeVendorsWorkflow,
} from "~/server/workflows/vendor.server";

export const vendorHandlers = implementOperationDomain(vendorContract, {
  options: (context) => vendorOptions(context.readDb),
  merge: (context, input) => mergeVendorsWorkflow(context, input),
  fetchLogo: (context, input) => fetchVendorLogoWorkflow(context, input),
});
