import { z } from "zod";
import { assessmentChildHandle } from "./assessment-reference";
import { entitySchema } from "./entity-core";

const refreshRoot = z.object({ entityKind: entitySchema, entityId: z.uuid() });
export const derivedRefreshOwners = z.array(refreshRoot);
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
  "EntitySource",
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

/** Transport is a wake-up; these limits bound each invocation's database work. */
export const DERIVED_REFRESH_ROOT_PAGE = 25;
export const DERIVED_REFRESH_PAGE = 100;
export const DERIVED_REFRESH_DISCOVERY_PAGE = 10;
export const DERIVED_REFRESH_MAX_FAILURES = 3;
export const DERIVED_REFRESH_RECONCILE_INTERVAL_MS = 60 * 60_000;

export const derivedRefreshState = z.enum(["pending", "failed", "completed"]);
export const derivedRefreshPhase = z.enum([
  "projection",
  "assessment",
  "recipe",
  "dependencies",
  "completed",
]);
export const derivedRefreshReconcileCursor = z.object({
  phase: z.enum(["inputs", "orphans", "roots", "recipes", "embeddings"]),
  table: z.number().int().nonnegative(),
  after: z.string().nullable(),
  startedAt: z.iso.datetime(),
});
export const derivedRefreshStatementCursor = z.object({
  phase: z.literal("statements"),
  after: assessmentChildHandle.nullable(),
  inputFingerprint: z.string(),
  completedFingerprint: z.string().nullable(),
});
export const derivedRefreshCursorState = z.union([
  derivedRefreshReconcileCursor,
  derivedRefreshStatementCursor,
]);

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

export const derivedRefreshWakeupTask = z.object({
  kind: z.literal("derived-refresh.wakeup"),
  requestedAt: z.iso.datetime(),
});
