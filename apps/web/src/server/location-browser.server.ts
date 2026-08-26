import { z } from "zod";
import {
  runStartOperation,
  type StartOperationRequest,
} from "~/server/start-operation.server";
import {
  bulkUpdateParentWorkflow,
  ensureGlobalUnknownWorkflow,
  getByShortcodesWorkflow,
  infLocation,
  infLocationListOut,
  inventoryBreakdownWorkflow,
  locationBulkUpdateParentInput,
  locationBulkUpdateParentOut,
  locationFiltersSchema,
  locationInventoryBreakdownOut,
  locationParentOptionsOut,
  locationPickerItemOut,
  locationSearchWorkflow,
  locationShortcodesInput,
  locationsWithParentNameOut,
  locationValuationSummaryOut,
  makeTreeWorkflow,
  parentOptionsWorkflow,
  recomputeLocationValuationsOut,
  recomputeValuationsWorkflow,
  subtreeWorkflow,
  valuationSummaryWorkflow,
} from "~/server/workflows/location.server";

const run = <I extends z.ZodType, O>(options: {
  operation: string;
  type: "query" | "mutation";
  input: unknown;
  inputSchema: I;
  outputSchema: z.ZodType<O>;
  request: StartOperationRequest;
  run: Parameters<typeof runStartOperation<I, O>>[0]["run"];
}) => runStartOperation(options);

export const makeTreeForBrowser = (options: {
  data: undefined;
  request: StartOperationRequest;
}) =>
  run({
    operation: "location.makeTree",
    type: "query",
    input: undefined,
    inputSchema: z.undefined(),
    outputSchema: infLocationListOut,
    request: options.request,
    run: makeTreeWorkflow,
  });
export const valuationSummaryForBrowser = (options: {
  data: undefined;
  request: StartOperationRequest;
}) =>
  run({
    operation: "location.valuationSummary",
    type: "query",
    input: undefined,
    inputSchema: z.undefined(),
    outputSchema: locationValuationSummaryOut,
    request: options.request,
    run: valuationSummaryWorkflow,
  });
export const subtreeForBrowser = (options: {
  data: { shortcode: string };
  request: StartOperationRequest;
}) =>
  run({
    operation: "location.subtree",
    type: "query",
    input: options.data,
    inputSchema: z.object({ shortcode: z.string() }),
    outputSchema: infLocationListOut,
    request: options.request,
    run: subtreeWorkflow,
  });
export const inventoryBreakdownForBrowser = (options: {
  data: { shortcode: string };
  request: StartOperationRequest;
}) =>
  run({
    operation: "location.inventoryBreakdown",
    type: "query",
    input: options.data,
    inputSchema: z.object({ shortcode: z.string() }),
    outputSchema: locationInventoryBreakdownOut.nullable(),
    request: options.request,
    run: inventoryBreakdownWorkflow,
  });
export const parentOptionsForBrowser = (options: {
  data: undefined;
  request: StartOperationRequest;
}) =>
  run({
    operation: "location.parentOptions",
    type: "query",
    input: undefined,
    inputSchema: z.undefined(),
    outputSchema: z.array(locationParentOptionsOut),
    request: options.request,
    run: parentOptionsWorkflow,
  });
export const ensureGlobalUnknownForBrowser = (options: {
  data: undefined;
  request: StartOperationRequest;
}) =>
  run({
    operation: "location.ensureGlobalUnknown",
    type: "mutation",
    input: undefined,
    inputSchema: z.undefined(),
    outputSchema: infLocation,
    request: options.request,
    run: ensureGlobalUnknownWorkflow,
  });
export const bulkUpdateParentForBrowser = (options: {
  data: z.input<typeof locationBulkUpdateParentInput>;
  request: StartOperationRequest;
}) =>
  run({
    operation: "location.bulkUpdateParent",
    type: "mutation",
    input: options.data,
    inputSchema: locationBulkUpdateParentInput,
    outputSchema: locationBulkUpdateParentOut,
    request: options.request,
    run: bulkUpdateParentWorkflow,
  });
export const getByShortcodesForBrowser = (options: {
  data: z.input<typeof locationShortcodesInput>;
  request: StartOperationRequest;
}) =>
  run({
    operation: "location.getByShortcodes",
    type: "query",
    input: options.data,
    inputSchema: locationShortcodesInput,
    outputSchema: locationsWithParentNameOut,
    request: options.request,
    run: getByShortcodesWorkflow,
  });
export const recomputeValuationsForBrowser = (options: {
  data: undefined;
  request: StartOperationRequest;
}) =>
  run({
    operation: "location.recomputeValuations",
    type: "mutation",
    input: undefined,
    inputSchema: z.undefined(),
    outputSchema: recomputeLocationValuationsOut,
    request: options.request,
    run: recomputeValuationsWorkflow,
  });

const rosterInput = z.object({
  filters: locationFiltersSchema,
  sort: z.object({ orderBy: z.string(), direction: z.enum(["asc", "desc"]) }),
  pagination: z.object({ pageIndex: z.number(), pageSize: z.number() }),
});
const searchOutput = z.object({
  data: z.array(locationPickerItemOut),
  count: z.number(),
});
export const searchForBrowser = (options: {
  data: z.input<typeof rosterInput>;
  request: StartOperationRequest;
}) =>
  run({
    operation: "location.search",
    type: "query",
    input: options.data,
    inputSchema: rosterInput,
    outputSchema: searchOutput,
    request: options.request,
    run: locationSearchWorkflow,
  });
