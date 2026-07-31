import type {
  ImpactItem,
  MergeCandidate,
  PreviewOperation,
  PreviewOperationInput,
} from "@cubby/schemas/entity-integrity";
import { previewOperationSchema } from "@cubby/schemas/entity-integrity";
import {
  unsafeCookbookId,
  unsafeExpenseId,
  unsafeIngredientId,
  unsafeInventoryId,
  unsafeLocationId,
  unsafeMealId,
  unsafeProductId,
  unsafeProjectId,
  unsafePurchaseId,
  unsafeRecipeId,
  unsafeTaskId,
  unsafeVendorId,
} from "@cubby/schemas/identifiers";
import { match } from "ts-pattern";
import type { Database } from "~/server/db";
import { previewDeleteCookbooks } from "~/server/repo/cookbook";
import { previewDeleteExpenses } from "~/server/repo/expense";
import { previewDeleteImages } from "~/server/repo/image";
import { previewDeleteIngredients } from "~/server/repo/ingredient/deletion";
import {
  previewMergeIngredientCandidates,
  previewMergeIngredients,
} from "~/server/repo/ingredient/merge";
import { previewDeleteInventoryEntries } from "~/server/repo/inventory/crud";
import { previewDeleteLocations } from "~/server/repo/location/crud";
import { previewDeleteMeals } from "~/server/repo/meal/crud";
import { previewDeleteProducts } from "~/server/repo/product/crud";
import { previewDeleteProjects } from "~/server/repo/project/crud";
import {
  previewDeletePurchases,
  previewMergePurchases,
} from "~/server/repo/purchase";
import { previewDeleteRecipes } from "~/server/repo/recipe/crud";
import { previewDeleteTasks } from "~/server/repo/task/crud";
import {
  previewDeleteVendors,
  previewMergeVendors,
} from "~/server/repo/vendor";

/**
 * Dispatch for `entityIntegrity.previewOperation`.
 *
 * Every arm calls a planner that lives beside the mutation it describes and
 * shares that mutation's own predicates — this file only routes. There is
 * deliberately no generic cascade walker: what a delete means is
 * domain-specific, and a generic implementation would re-derive it and get it
 * subtly wrong.
 *
 * The result is ADVISORY. Mutations re-check everything inside their own
 * transaction; a preview is not a lock, an authorization token, or a receipt,
 * and nothing may skip a check because a preview looked clean.
 */

type Planned = {
  blockers: ImpactItem[];
  changes: ImpactItem[];
  sideEffects?: ImpactItem[];
  candidates?: MergeCandidate[];
};

const plan = async (
  db: Database,
  input: PreviewOperationInput,
): Promise<Planned> =>
  match(input)
    .with({ operation: "delete", entity: "product" }, ({ ids }) =>
      previewDeleteProducts(db, ids.map(unsafeProductId)),
    )
    .with({ operation: "delete", entity: "recipe" }, ({ ids }) =>
      previewDeleteRecipes(db, ids.map(unsafeRecipeId)),
    )
    .with({ operation: "delete", entity: "ingredient" }, ({ ids }) =>
      previewDeleteIngredients(db, ids.map(unsafeIngredientId)),
    )
    .with({ operation: "delete", entity: "cookbook" }, ({ ids }) =>
      previewDeleteCookbooks(db, ids.map(unsafeCookbookId)),
    )
    .with({ operation: "delete", entity: "meal" }, ({ ids }) =>
      previewDeleteMeals(db, ids.map(unsafeMealId)),
    )
    .with({ operation: "delete", entity: "location" }, ({ ids }) =>
      previewDeleteLocations(db, ids.map(unsafeLocationId)),
    )
    .with({ operation: "delete", entity: "project" }, ({ ids }) =>
      previewDeleteProjects(db, ids.map(unsafeProjectId)),
    )
    .with({ operation: "delete", entity: "task" }, ({ ids }) =>
      previewDeleteTasks(db, ids.map(unsafeTaskId)),
    )
    .with({ operation: "delete", entity: "vendor" }, ({ ids }) =>
      previewDeleteVendors(db, ids.map(unsafeVendorId)),
    )
    .with({ operation: "delete", entity: "purchase" }, ({ ids }) =>
      previewDeletePurchases(db, ids.map(unsafePurchaseId)),
    )
    .with({ operation: "delete", entity: "expense" }, ({ ids }) =>
      previewDeleteExpenses(db, ids.map(unsafeExpenseId)),
    )
    .with({ operation: "delete", entity: "inventory" }, ({ ids }) =>
      previewDeleteInventoryEntries(db, ids.map(unsafeInventoryId)),
    )
    .with({ operation: "delete", entity: "image" }, ({ ids }) =>
      previewDeleteImages(db, ids),
    )
    // Merge with no keeper named: the dialogs need per-candidate impact in
    // order to CHOOSE one, so this arm returns ranking data and no impact.
    .with(
      { operation: "merge", entity: "ingredient", keepId: undefined },
      async ({ mergeIds }) => ({
        blockers: [],
        changes: [],
        candidates: await previewMergeIngredientCandidates(
          db,
          mergeIds.map(unsafeIngredientId),
        ),
      }),
    )
    .with(
      { operation: "merge", entity: "ingredient" },
      ({ mergeIds, keepId }) =>
        previewMergeIngredients(db, {
          mergeIds: mergeIds.map(unsafeIngredientId),
          keepId: unsafeIngredientId(keepId ?? ""),
        }),
    )
    .with({ operation: "merge", entity: "vendor" }, ({ mergeIds, keepId }) =>
      previewMergeVendors(db, {
        mergeIds: mergeIds.map(unsafeVendorId),
        keepId: unsafeVendorId(keepId ?? ""),
      }),
    )
    .with({ operation: "merge", entity: "purchase" }, ({ mergeIds, keepId }) =>
      previewMergePurchases(db, {
        mergeIds: mergeIds.map(unsafePurchaseId),
        keepId: unsafePurchaseId(keepId ?? ""),
      }),
    )
    .exhaustive();

export const previewOperation = async (
  db: Database,
  input: PreviewOperationInput,
  now: Date,
): Promise<PreviewOperation> => {
  const planned = await plan(db, input);
  const targetCount =
    input.operation === "delete" ? input.ids.length : input.mergeIds.length;

  return previewOperationSchema.parse({
    operation: input.operation,
    entity: input.entity,
    // Only a delete has a mode, and `image` is the one hard delete.
    mode:
      input.operation === "delete"
        ? input.entity === "image"
          ? "hard"
          : "soft"
        : null,
    targetCount,
    canProceed: planned.blockers.length === 0,
    blockers: planned.blockers,
    changes: planned.changes,
    sideEffects: planned.sideEffects ?? [],
    ...(planned.candidates ? { candidates: planned.candidates } : {}),
    generatedAt: now.toISOString(),
  });
};
