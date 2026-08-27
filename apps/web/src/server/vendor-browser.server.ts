import { vendor } from "~/app/vendors/vendor.functions";
import { implementOperationDomain } from "~/server/operation-domain.server";
import {
  fetchVendorLogoWorkflow,
  mergeVendorsWorkflow,
  vendorOptionsWorkflow,
} from "~/server/workflows/vendor.server";

export const vendorHandlers = implementOperationDomain(vendor, {
  options: (context) => vendorOptionsWorkflow(context),
  merge: (context, input) => mergeVendorsWorkflow(context, input),
  fetchLogo: (context, input) => fetchVendorLogoWorkflow(context, input),
});
