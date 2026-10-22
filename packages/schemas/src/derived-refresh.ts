import { z } from "zod";
import { entitySchema } from "./entity-core";

const refreshRoot = z.object({ entityKind: entitySchema, entityId: z.uuid() });
export const derivedRefreshCapture = refreshRoot.extend({
  auditId: z.uuid().optional(),
  scopes: z.array(refreshRoot).optional(),
  changedFields: z.array(z.string()).optional(),
});
export type DerivedRefreshCapture = z.infer<typeof derivedRefreshCapture>;
export const derivedRefreshContext = z.enum([
  "EntityLink",
  "EntityAttachment",
  "EntityExternalId",
  "AiAnalysis",
  "FinancialTransactionAllocation",
  "ExpenseAttribution",
  "ProductUnitMapping",
  "RecipeSection",
  "RecipeSectionIngredient",
  "MealRecipe",
  "MealFoodEntry",
  "ImportSourceProduct",
  "ImportSourceOrder",
  "OrderMail",
  "OrderMailEvent",
  "AssessmentState",
  "StatementRow",
]);
export type DerivedRefreshContext = z.infer<typeof derivedRefreshContext>;

export const derivedRefreshReceipt = z.object({
  mode: z.literal("background"),
});

export const embeddingArtifactState = z.enum([
  "legacy",
  "prepared",
  "submitting",
  "submitted",
  "selected",
  "retired",
  "failed",
]);
