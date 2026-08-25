import { z } from "zod";
import {
  runStartOperation,
  type StartOperationRequest,
} from "~/server/start-operation.server";
import {
  fetchVendorLogoInput,
  fetchVendorLogoWorkflow,
  mergeVendorsInput,
  mergeVendorsOut,
  mergeVendorsWorkflow,
  vendorOptionsOut,
  vendorOptionsWorkflow,
  vendorOut,
} from "~/server/workflows/vendor.server";

export const vendorOptionsForBrowser = (options: {
  request: StartOperationRequest;
}) =>
  runStartOperation({
    operation: "vendor.options",
    type: "query",
    input: undefined,
    inputSchema: z.undefined(),
    outputSchema: vendorOptionsOut,
    request: options.request,
    run: (context) => vendorOptionsWorkflow(context),
  });

export const mergeVendorsForBrowser = (options: {
  data: z.input<typeof mergeVendorsInput>;
  request: StartOperationRequest;
}) =>
  runStartOperation({
    operation: "vendor.merge",
    type: "mutation",
    input: options.data,
    inputSchema: mergeVendorsInput,
    outputSchema: mergeVendorsOut,
    request: options.request,
    run: (context, input) => mergeVendorsWorkflow(context, input),
  });

export const fetchVendorLogoForBrowser = (options: {
  data: z.input<typeof fetchVendorLogoInput>;
  request: StartOperationRequest;
}) =>
  runStartOperation({
    operation: "vendor.fetchLogo",
    type: "mutation",
    input: options.data,
    inputSchema: fetchVendorLogoInput,
    outputSchema: vendorOut,
    request: options.request,
    run: (context, input) => fetchVendorLogoWorkflow(context, input),
  });
