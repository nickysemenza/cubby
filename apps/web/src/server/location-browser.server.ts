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

export const makeTreeForBrowser = (request: StartOperationRequest) =>
  run({
    operation: "location.makeTree",
    type: "query",
    input: undefined,
    inputSchema: z.undefined(),
    outputSchema: infLocationListOut,
    request,
    run: makeTreeWorkflow,
  });
export const valuationSummaryForBrowser = (request: StartOperationRequest) =>
  run({
    operation: "location.valuationSummary",
    type: "query",
    input: undefined,
    inputSchema: z.undefined(),
    outputSchema: locationValuationSummaryOut,
    request,
    run: valuationSummaryWorkflow,
  });
export const subtreeForBrowser = (
  data: { shortcode: string },
  request: StartOperationRequest,
) =>
  run({
    operation: "location.subtree",
    type: "query",
    input: data,
    inputSchema: z.object({ shortcode: z.string() }),
    outputSchema: infLocationListOut,
    request,
    run: subtreeWorkflow,
  });
export const inventoryBreakdownForBrowser = (
  data: { shortcode: string },
  request: StartOperationRequest,
) =>
  run({
    operation: "location.inventoryBreakdown",
    type: "query",
    input: data,
    inputSchema: z.object({ shortcode: z.string() }),
    outputSchema: locationInventoryBreakdownOut.nullable(),
    request,
    run: inventoryBreakdownWorkflow,
  });
export const parentOptionsForBrowser = (request: StartOperationRequest) =>
  run({
    operation: "location.parentOptions",
    type: "query",
    input: undefined,
    inputSchema: z.undefined(),
    outputSchema: z.array(locationParentOptionsOut),
    request,
    run: parentOptionsWorkflow,
  });
export const ensureGlobalUnknownForBrowser = (request: StartOperationRequest) =>
  run({
    operation: "location.ensureGlobalUnknown",
    type: "mutation",
    input: undefined,
    inputSchema: z.undefined(),
    outputSchema: infLocation,
    request,
    run: ensureGlobalUnknownWorkflow,
  });
export const bulkUpdateParentForBrowser = (
  data: z.input<typeof locationBulkUpdateParentInput>,
  request: StartOperationRequest,
) =>
  run({
    operation: "location.bulkUpdateParent",
    type: "mutation",
    input: data,
    inputSchema: locationBulkUpdateParentInput,
    outputSchema: locationBulkUpdateParentOut,
    request,
    run: bulkUpdateParentWorkflow,
  });
export const getByShortcodesForBrowser = (
  data: z.input<typeof locationShortcodesInput>,
  request: StartOperationRequest,
) =>
  run({
    operation: "location.getByShortcodes",
    type: "query",
    input: data,
    inputSchema: locationShortcodesInput,
    outputSchema: locationsWithParentNameOut,
    request,
    run: getByShortcodesWorkflow,
  });
export const recomputeValuationsForBrowser = (request: StartOperationRequest) =>
  run({
    operation: "location.recomputeValuations",
    type: "mutation",
    input: undefined,
    inputSchema: z.undefined(),
    outputSchema: recomputeLocationValuationsOut,
    request,
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
export const searchForBrowser = (
  data: z.input<typeof rosterInput>,
  request: StartOperationRequest,
) =>
  run({
    operation: "location.search",
    type: "query",
    input: data,
    inputSchema: rosterInput,
    outputSchema: searchOutput,
    request,
    run: locationSearchWorkflow,
  });
