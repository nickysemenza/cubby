import type { z } from "zod";
import {
  runStartOperation,
  type StartOperationRequest,
} from "~/server/start-operation.server";
import {
  aiWorkflowSchemas,
  approveDetectedInventoryItemWorkflow,
  auditCategoriesWorkflow,
  describeLocationWorkflow,
  detectInventoryItemsWorkflow,
  identifyProductWorkflow,
  listAiUsageRecentWorkflow,
  parseSearchWorkflow,
  suggestCategoryWorkflow,
  suggestIngredientMergeBatchWorkflow,
  suggestLocationTypeWorkflow,
  suggestLocationWorkflow,
  suggestUsdaFoodBatchWorkflow,
  suggestUsdaFoodWorkflow,
  summarizeAiUsageWorkflow,
} from "~/server/workflows/ai.server";

const schemas = aiWorkflowSchemas;
const operation = <I extends z.ZodType, O>(options: {
  name: string;
  type: "query" | "mutation";
  input: I;
  output: z.ZodType<O>;
  data: z.input<I>;
  request: StartOperationRequest;
  run: Parameters<typeof runStartOperation<I, O>>[0]["run"];
}) =>
  runStartOperation({
    operation: options.name,
    type: options.type,
    input: options.data,
    inputSchema: options.input,
    outputSchema: options.output,
    request: options.request,
    ...(options.type === "query" ? { readPolicy: "strong" as const } : {}),
    run: options.run,
  });

export const suggestCategoryForBrowser = (o: {
  data: z.input<typeof schemas.suggestCategory.input>;
  request: StartOperationRequest;
}) =>
  operation({
    name: "ai.suggestCategory",
    type: "query",
    input: schemas.suggestCategory.input,
    output: schemas.suggestCategory.output,
    ...o,
    run: (c, input) => suggestCategoryWorkflow(c.db, input),
  });
export const suggestLocationTypeForBrowser = (o: {
  data: z.input<typeof schemas.suggestLocationType.input>;
  request: StartOperationRequest;
}) =>
  operation({
    name: "ai.suggestLocationType",
    type: "query",
    input: schemas.suggestLocationType.input,
    output: schemas.suggestLocationType.output,
    ...o,
    run: (c, input) => suggestLocationTypeWorkflow(c.db, input),
  });
export const suggestLocationForBrowser = (o: {
  data: z.input<typeof schemas.suggestLocation.input>;
  request: StartOperationRequest;
}) =>
  operation({
    name: "ai.suggestLocation",
    type: "query",
    input: schemas.suggestLocation.input,
    output: schemas.suggestLocation.output,
    ...o,
    run: (c, input) => suggestLocationWorkflow(c.db, input),
  });
export const describeLocationForBrowser = (o: {
  data: z.input<typeof schemas.describeLocation.input>;
  request: StartOperationRequest;
}) =>
  operation({
    name: "ai.describeLocation",
    type: "mutation",
    input: schemas.describeLocation.input,
    output: schemas.describeLocation.output,
    ...o,
    run: (c, input) => describeLocationWorkflow(c.db, input),
  });
export const detectInventoryItemsForBrowser = (o: {
  data: z.input<typeof schemas.detectInventoryItems.input>;
  request: StartOperationRequest;
}) =>
  operation({
    name: "ai.detectInventoryItems",
    type: "mutation",
    input: schemas.detectInventoryItems.input,
    output: schemas.detectInventoryItems.output,
    ...o,
    run: (c, input) => detectInventoryItemsWorkflow(c.db, input),
  });
export const approveDetectedInventoryItemForBrowser = (o: {
  data: z.input<typeof schemas.approveDetectedInventoryItem.input>;
  request: StartOperationRequest;
}) =>
  operation({
    name: "ai.approveDetectedInventoryItem",
    type: "mutation",
    input: schemas.approveDetectedInventoryItem.input,
    output: schemas.approveDetectedInventoryItem.output,
    ...o,
    run: (c, input) => approveDetectedInventoryItemWorkflow(c, input),
  });
export const identifyProductForBrowser = (o: {
  data: z.input<typeof schemas.identifyProduct.input>;
  request: StartOperationRequest;
}) =>
  operation({
    name: "ai.identifyProduct",
    type: "mutation",
    input: schemas.identifyProduct.input,
    output: schemas.identifyProduct.output,
    ...o,
    run: (c, input) => identifyProductWorkflow(c.db, input),
  });
export const suggestUsdaFoodForBrowser = (o: {
  data: z.input<typeof schemas.suggestUsdaFood.input>;
  request: StartOperationRequest;
}) =>
  operation({
    name: "ai.suggestUsdaFood",
    type: "mutation",
    input: schemas.suggestUsdaFood.input,
    output: schemas.suggestUsdaFood.output,
    ...o,
    run: suggestUsdaFoodWorkflow,
  });
export const suggestUsdaFoodBatchForBrowser = (o: {
  data: z.input<typeof schemas.suggestUsdaFoodBatch.input>;
  request: StartOperationRequest;
}) =>
  operation({
    name: "ai.suggestUsdaFoodBatch",
    type: "mutation",
    input: schemas.suggestUsdaFoodBatch.input,
    output: schemas.suggestUsdaFoodBatch.output,
    ...o,
    run: suggestUsdaFoodBatchWorkflow,
  });
export const suggestIngredientMergeBatchForBrowser = (o: {
  data: z.input<typeof schemas.suggestIngredientMergeBatch.input>;
  request: StartOperationRequest;
}) =>
  operation({
    name: "ai.suggestIngredientMergeBatch",
    type: "mutation",
    input: schemas.suggestIngredientMergeBatch.input,
    output: schemas.suggestIngredientMergeBatch.output,
    ...o,
    run: (c, input) => suggestIngredientMergeBatchWorkflow(c.db, input),
  });
export const parseSearchForBrowser = (o: {
  data: z.input<typeof schemas.parseSearch.input>;
  request: StartOperationRequest;
}) =>
  operation({
    name: "ai.parseSearch",
    type: "mutation",
    input: schemas.parseSearch.input,
    output: schemas.parseSearch.output,
    ...o,
    run: (c, input) => parseSearchWorkflow(c.db, input),
  });
export const auditCategoriesForBrowser = (o: {
  request: StartOperationRequest;
}) =>
  operation({
    name: "ai.auditCategories",
    type: "mutation",
    input: schemas.auditCategories.input,
    output: schemas.auditCategories.output,
    data: undefined,
    ...o,
    run: (c) => auditCategoriesWorkflow(c.db),
  });
export const listAiUsageRecentForBrowser = (o: {
  data: z.input<typeof schemas.usageRecent.input>;
  request: StartOperationRequest;
}) =>
  operation({
    name: "ai.usageRecent",
    type: "query",
    input: schemas.usageRecent.input,
    output: schemas.usageRecent.output,
    ...o,
    run: (c, input) => listAiUsageRecentWorkflow(c.db, input),
  });
export const summarizeAiUsageForBrowser = (o: {
  data: z.input<typeof schemas.usageSummary.input>;
  request: StartOperationRequest;
}) =>
  operation({
    name: "ai.usageSummary",
    type: "query",
    input: schemas.usageSummary.input,
    output: schemas.usageSummary.output,
    ...o,
    run: (c, input) => summarizeAiUsageWorkflow(c.db, input),
  });
