import { z } from "zod";

import { fieldSuggestionsInput } from "./ai";

const sourceId = z.string().min(1);
const sourceIds = z.array(sourceId).min(1).max(20);
const fixture = z.enum(["standard", "ambiguous"]);

/** Browser-only AI probes. Shortcodes are resolved at the server boundary. */
export const aiSmokeInputs = {
  fieldSuggestions: fieldSuggestionsInput.omit({ runKey: true }),
  externalIdKind: z.object({
    fixture: z.enum(["manufacturer_sku", "barcode"]),
  }),
  usdaFood: z.object({ ingredientId: sourceId }),
  usdaFoodBatch: z.object({ ingredientIds: sourceIds }),
  ingredientMerge: z.object({ ingredientIds: sourceIds }),
  selectionOverflow: z.object({ fixture }),
  productIdentification: z.object({
    imageIds: z.array(sourceId).min(1).max(5),
  }),
  locationDescription: z.object({ locationId: sourceId }),
  inventoryDetection: z.object({ locationId: sourceId }),
  imageDescription: z.object({ imageId: sourceId }),
  recipeFlow: z.object({ recipeId: sourceId }),
  purchaseProductIdentity: z.object({
    fixture,
    productId: sourceId.optional(),
  }),
  purchaseExpenseLineRole: z.object({ fixture }),
  purchaseKitDetection: z.object({ fixture }),
  purchaseProductPromotion: z.object({ fixture }),
  purchaseReversalKind: z.object({ fixture }),
  purchaseExtraction: z.object({ fixture }),
  purchaseReceipt: z.object({ imageId: sourceId }),
  purchaseMail: z.object({ fixture }),
  purchaseAudit: z.object({
    source: z.enum(["synthetic", "run"]),
    fixture,
    runId: sourceId.optional(),
  }),
  purchaseRepair: z.object({ fixture }),
  semanticQuery: z.object({ fixture }),
  entityEmbedding: z.object({ productId: sourceId }),
} as const;

export const aiSmokeScenario = z.enum(
  // SAFETY: aiSmokeInputs is a nonempty literal object; Object.keys preserves its keys.
  Object.keys(aiSmokeInputs) as [
    keyof typeof aiSmokeInputs,
    ...(keyof typeof aiSmokeInputs)[],
  ],
);
export type AiSmokeScenario = z.infer<typeof aiSmokeScenario>;

export const aiSmokeRunInput = z.object({
  scenario: aiSmokeScenario,
  input: z.json(),
});

export const aiSmokeScenarioSchema = z.object({
  id: aiSmokeScenario,
  feature: z.string(),
  label: z.string(),
  description: z.string(),
  group: z.string(),
  model: z.string(),
  tier: z.string(),
  inputSchema: z.json(),
});

export const aiSmokeCatalogOut = z.array(aiSmokeScenarioSchema);
export const aiSmokeRunOut = z.object({
  status: z.enum(["ok", "error", "no_model_call"]),
  feature: z.string(),
  model: z.string(),
  runShortcode: z.string(),
  durationMs: z.number().nonnegative(),
  result: z.json().optional(),
  error: z.string().optional(),
});

export function parseAiSmokeInput(value: z.input<typeof aiSmokeRunInput>) {
  const parsed = aiSmokeRunInput.parse(value);
  const schema = aiSmokeInputs[parsed.scenario];
  return { scenario: parsed.scenario, input: schema.parse(parsed.input) };
}
