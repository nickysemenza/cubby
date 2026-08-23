import { entityRefKey } from "@cubby/schemas/entity";
import type {
  ImpactItem,
  MergeCandidate,
  PreviewOperation,
  PreviewOperationInput,
  PreviewOperationRequest,
  PublicImpactItem,
} from "@cubby/schemas/entity-integrity";
import {
  narrowPreviewOperationInput,
  previewOperationSchema,
  toPublicImpact,
} from "@cubby/schemas/entity-integrity";
import {
  unsafeCookbookId,
  unsafeExpenseId,
  unsafeFinancialAccountId,
  unsafeFinancialTransactionId,
  unsafeIngredientId,
  unsafeInventoryId,
  unsafeLocationId,
  unsafeMealId,
  unsafePersonId,
  unsafeProductId,
  unsafeProjectId,
  unsafePurchaseId,
  unsafeRecipeId,
  unsafeTaskId,
  unsafeVendorId,
  unsafeWishId,
} from "@cubby/schemas/identifiers";
import { match } from "ts-pattern";
import type { Database } from "~/server/db";
import { previewDeleteCookbooks } from "~/server/repo/cookbook";
import { previewDeleteExpenses } from "~/server/repo/expense";
import { previewDeleteFinancialAccounts } from "~/server/repo/financial-account";
import { previewDeleteFinancialTransactions } from "~/server/repo/financial-transaction";
import { previewDeleteImages } from "~/server/repo/image";
import { previewDeleteIngredients } from "~/server/repo/ingredient/deletion";
import {
  previewMergeIngredientCandidates,
  previewMergeIngredients,
} from "~/server/repo/ingredient/merge";
import { previewDeleteInventoryEntries } from "~/server/repo/inventory/crud";
import { previewDeleteLocations } from "~/server/repo/location/crud";
import { previewDeleteMeals } from "~/server/repo/meal/crud";
import { previewDeletePeople, previewMergePeople } from "~/server/repo/person";
import { previewDeleteProducts } from "~/server/repo/product/crud";
import { previewMergeProducts } from "~/server/repo/product/merge";
import {
  previewAttachProductComponents,
  previewDetachProductComponents,
} from "~/server/repo/product-components";
import { previewDeleteProjects } from "~/server/repo/project/crud";
import {
  previewAttachProjectResources,
  previewDetachProjectResources,
} from "~/server/repo/project/tools";
import {
  previewDeletePurchases,
  previewMergePurchases,
} from "~/server/repo/purchase";
import {
  previewAttachPurchaseProducts,
  previewDetachPurchaseProducts,
} from "~/server/repo/purchase-products";
import { previewDeleteRecipes } from "~/server/repo/recipe/crud";
import {
  lookupShortcodes,
  resolveLiveShortcodes,
} from "~/server/repo/shortcode-resolver";
import { previewDeleteTasks } from "~/server/repo/task/crud";
import {
  previewDeleteVendors,
  previewMergeVendors,
} from "~/server/repo/vendor";
import { previewDeleteWishes } from "~/server/repo/wish";

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

const EMPTY_PLAN: Planned = { blockers: [], changes: [] };

/**
 * Why a preview couldn't be planned, when it couldn't. Both cases used to
 * produce a confident, empty, wrong preview rather than saying anything.
 */
type PlanGap = {
  /** Well-formed ids that name no live row. */
  unresolved?: string[];
  /** A non-ingredient merge with no `keepId` — nothing to compute. */
  needsKeeper?: boolean;
};

const plan = async (
  db: Database,
  input: PreviewOperationRequest,
): Promise<
  {
    planned: Planned;
    publicIdByEntityId: Map<string, string>;
  } & PlanGap
> => {
  // Relation verbs are dispatched apart from delete/merge: their targets are
  // PRODUCTS, in a different id space from the `entity` the parent names, so
  // they need two resolutions rather than one.
  // Spelled as an EXCLUSION rather than `=== "attach" || === "detach"`: the
  // relation member's discriminant is itself a union (`"attach" | "detach"`),
  // and TypeScript does not remove such a member from the negative branch of an
  // `||` — so the positive form left every arm below reading `ids`/`mergeIds`
  // off a union that still contained it. `req` then carries the narrowing into
  // the `match` and the closures.
  if (input.operation !== "delete" && input.operation !== "merge") {
    return planRelation(db, input);
  }
  const req = input;
  // Bound to a local const so the `!== "image"` narrowing survives into the
  // closures below — TypeScript drops property-path narrowings inside callbacks.
  const entity = req.entity;
  const publicIds =
    req.operation === "delete"
      ? req.ids
      : [...req.mergeIds, ...(req.keepId ? [req.keepId] : [])];
  const entityIdsByPublicId =
    entity === "image"
      ? new Map(publicIds.map((id) => [id, id]))
      : await resolveLiveShortcodes(db, publicIds, entity);
  // Every id the caller named that doesn't resolve to a live row. Reported
  // rather than dropped: a preview silently planned over the survivors renders
  // as "nothing will be affected", which reads as *this operation is harmless*
  // when the truth is *you named something that doesn't exist*. The wire schema
  // already rejects a malformed code, so anything here is well-formed and
  // simply gone (or soft-deleted).
  const unresolved = publicIds.filter((id) => !entityIdsByPublicId.has(id));
  if (unresolved.length > 0) {
    return { planned: EMPTY_PLAN, publicIdByEntityId: new Map(), unresolved };
  }

  // A merge preview with no keeper is only answerable for `ingredient`, which
  // has a candidate-ranking arm below. For the others there is nothing to
  // compute — the old sentinel passed `""` as the keeper, producing a confident
  // empty preview of a merge that could never run.
  if (req.operation === "merge" && !req.keepId && entity !== "ingredient") {
    return {
      planned: EMPTY_PLAN,
      publicIdByEntityId: new Map(),
      needsKeeper: true,
    };
  }

  const entityIds = (ids: readonly string[]) =>
    ids.flatMap((id) => {
      const entityId = entityIdsByPublicId.get(id);
      return entityId ? [entityId] : [];
    });
  // Total past the guard above: every public id resolved, or we returned.
  const entityId = (id: string | undefined): string => {
    const resolved = id === undefined ? undefined : entityIdsByPublicId.get(id);
    if (resolved === undefined) {
      throw new Error(`unreachable: unresolved ${entity} keeper ${id}`);
    }
    return resolved;
  };

  const planned = await match(req)
    .with({ operation: "delete", entity: "product" }, ({ ids }) =>
      previewDeleteProducts(db, entityIds(ids).map(unsafeProductId)),
    )
    .with({ operation: "delete", entity: "recipe" }, ({ ids }) =>
      previewDeleteRecipes(db, entityIds(ids).map(unsafeRecipeId)),
    )
    .with({ operation: "delete", entity: "ingredient" }, ({ ids }) =>
      previewDeleteIngredients(db, entityIds(ids).map(unsafeIngredientId)),
    )
    .with({ operation: "delete", entity: "cookbook" }, ({ ids }) =>
      previewDeleteCookbooks(db, entityIds(ids).map(unsafeCookbookId)),
    )
    .with({ operation: "delete", entity: "meal" }, ({ ids }) =>
      previewDeleteMeals(db, entityIds(ids).map(unsafeMealId)),
    )
    .with({ operation: "delete", entity: "location" }, ({ ids }) =>
      previewDeleteLocations(db, entityIds(ids).map(unsafeLocationId)),
    )
    .with({ operation: "delete", entity: "project" }, ({ ids }) =>
      previewDeleteProjects(db, entityIds(ids).map(unsafeProjectId)),
    )
    .with({ operation: "delete", entity: "task" }, ({ ids }) =>
      previewDeleteTasks(db, entityIds(ids).map(unsafeTaskId)),
    )
    .with({ operation: "delete", entity: "vendor" }, ({ ids }) =>
      previewDeleteVendors(db, entityIds(ids).map(unsafeVendorId)),
    )
    .with({ operation: "delete", entity: "purchase" }, ({ ids }) =>
      previewDeletePurchases(db, entityIds(ids).map(unsafePurchaseId)),
    )
    .with({ operation: "delete", entity: "expense" }, ({ ids }) =>
      previewDeleteExpenses(db, entityIds(ids).map(unsafeExpenseId)),
    )
    .with({ operation: "delete", entity: "financialAccount" }, ({ ids }) =>
      previewDeleteFinancialAccounts(
        db,
        entityIds(ids).map(unsafeFinancialAccountId),
      ),
    )
    .with({ operation: "delete", entity: "financialTransaction" }, ({ ids }) =>
      previewDeleteFinancialTransactions(
        db,
        entityIds(ids).map(unsafeFinancialTransactionId),
      ),
    )
    .with({ operation: "delete", entity: "inventory" }, ({ ids }) =>
      previewDeleteInventoryEntries(db, entityIds(ids).map(unsafeInventoryId)),
    )
    .with({ operation: "delete", entity: "wish" }, ({ ids }) =>
      previewDeleteWishes(db, entityIds(ids).map(unsafeWishId)),
    )
    .with({ operation: "delete", entity: "person" }, ({ ids }) =>
      previewDeletePeople(db, entityIds(ids).map(unsafePersonId)),
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
          entityIds(mergeIds).map(unsafeIngredientId),
        ),
      }),
    )
    .with(
      { operation: "merge", entity: "ingredient" },
      ({ mergeIds, keepId }) =>
        previewMergeIngredients(db, {
          mergeIds: entityIds(mergeIds).map(unsafeIngredientId),
          keepId: unsafeIngredientId(entityId(keepId)),
        }),
    )
    .with({ operation: "merge", entity: "vendor" }, ({ mergeIds, keepId }) =>
      previewMergeVendors(db, {
        mergeIds: entityIds(mergeIds).map(unsafeVendorId),
        keepId: unsafeVendorId(entityId(keepId)),
      }),
    )
    .with({ operation: "merge", entity: "purchase" }, ({ mergeIds, keepId }) =>
      previewMergePurchases(db, {
        mergeIds: entityIds(mergeIds).map(unsafePurchaseId),
        keepId: unsafePurchaseId(entityId(keepId)),
      }),
    )
    .with({ operation: "merge", entity: "product" }, ({ mergeIds, keepId }) =>
      previewMergeProducts(db, {
        mergeIds: entityIds(mergeIds).map(unsafeProductId),
        keepId: unsafeProductId(entityId(keepId)),
      }),
    )
    .with({ operation: "merge", entity: "person" }, ({ mergeIds, keepId }) =>
      previewMergePeople(db, {
        mergeIds: entityIds(mergeIds).map(unsafePersonId),
        keepId: unsafePersonId(entityId(keepId)),
      }),
    )
    .exhaustive();

  const publicIdByEntityId =
    entity === "image"
      ? new Map(entityIdsByPublicId.entries())
      : await lookupShortcodes(
          db,
          [...entityIdsByPublicId.values()].map((id) => ({
            entity,
            id,
          })),
        ).then(
          (codes) =>
            new Map(
              [...entityIdsByPublicId.values()].flatMap((id) => {
                const code = codes.get(entityRefKey(entity, id));
                return code ? [[id, code] as const] : [];
              }),
            ),
        );
  return { planned, publicIdByEntityId };
};

/**
 * The attach/detach arm.
 *
 * Every planner it reaches shares the mutation's OWN predicate — see
 * `repo/relation-preflight.ts` — rather than re-deriving what an attach checks.
 * The parent's prefix has already been agreed with `entity` by the input
 * schema's refine, so the dispatch here is a plain three-way match.
 */
const planRelation = async (
  db: Database,
  input: Extract<PreviewOperationRequest, { operation: "attach" | "detach" }>,
): Promise<
  { planned: Planned; publicIdByEntityId: Map<string, string> } & PlanGap
> => {
  const [parentIds, productIds] = await Promise.all([
    resolveLiveShortcodes(db, [input.parentId], input.entity),
    resolveLiveShortcodes(db, input.productIds, "product"),
  ]);
  const unresolved = [
    ...(parentIds.has(input.parentId) ? [] : [input.parentId]),
    ...input.productIds.filter((code) => !productIds.has(code)),
  ];
  if (unresolved.length > 0) {
    return { planned: EMPTY_PLAN, publicIdByEntityId: new Map(), unresolved };
  }
  // Total past the guard: `parentIds` has the key or we returned.
  const parentId = parentIds.get(input.parentId)!;
  const targets = input.productIds.map((code) =>
    unsafeProductId(productIds.get(code)!),
  );

  const planned = await match(input)
    .with({ operation: "attach", entity: "product" }, () =>
      previewAttachProductComponents(db, unsafeProductId(parentId), targets),
    )
    .with({ operation: "detach", entity: "product" }, () =>
      previewDetachProductComponents(db, unsafeProductId(parentId), targets),
    )
    .with({ operation: "attach", entity: "project" }, () =>
      previewAttachProjectResources(db, unsafeProjectId(parentId), targets),
    )
    .with({ operation: "detach", entity: "project" }, () =>
      previewDetachProjectResources(db, unsafeProjectId(parentId), targets),
    )
    .with({ operation: "attach", entity: "purchase" }, () =>
      previewAttachPurchaseProducts(db, unsafePurchaseId(parentId), targets),
    )
    .with({ operation: "detach", entity: "purchase" }, () =>
      previewDetachPurchaseProducts(db, unsafePurchaseId(parentId), targets),
    )
    .exhaustive();

  // Both id spaces, one map: blockers and changes are keyed by PRODUCT uuid,
  // and the parent-level blocker keys by nothing at all.
  const codes = await lookupShortcodes(db, [
    { entity: input.entity, id: parentId },
    ...targets.map((id) => ({ entity: "product" as const, id })),
  ]);
  const publicIdByEntityId = new Map(
    [
      [input.entity, parentId] as const,
      ...targets.map((id) => ["product", id] as const),
    ].flatMap(([entity, id]) => {
      const code = codes.get(entityRefKey(entity, id));
      return code ? [[id, code] as const] : [];
    }),
  );
  return { planned, publicIdByEntityId };
};

export const previewOperation = async (
  db: Database,
  input: PreviewOperationInput,
  now: Date,
): Promise<PreviewOperation> => {
  // The wire input is a flat object (MCP can't advertise a union); narrowing it
  // once here is what lets every arm below stay exhaustively matched.
  const request = narrowPreviewOperationInput(input);
  const { planned, publicIdByEntityId, unresolved, needsKeeper } = await plan(
    db,
    request,
  );
  const targetCount =
    request.operation === "delete"
      ? request.ids.length
      : request.operation === "merge"
        ? request.mergeIds.length
        : request.productIds.length;

  return previewOperationSchema.parse({
    operation: request.operation,
    entity: request.entity,
    // Only a delete has a mode, and `image` is the one hard delete.
    mode:
      request.operation === "delete"
        ? request.entity === "image"
          ? "hard"
          : "soft"
        : null,
    targetCount,
    canProceed: planned.blockers.length === 0 && !unresolved && !needsKeeper,
    // Gap blockers are appended AFTER translation on purpose: they are already
    // keyed by public code, and `publicImpact` drops any `byTargetId` key it
    // can't map back from an entity id — which is every key here, since these
    // ids resolved to nothing.
    blockers: [
      ...planned.blockers.map((item) => publicImpact(item, publicIdByEntityId)),
      ...(unresolved ? [unresolvedBlocker(request.entity, unresolved)] : []),
      ...(needsKeeper ? [needsKeeperBlocker(request.entity)] : []),
    ],
    changes: planned.changes.map((item) =>
      publicImpact(item, publicIdByEntityId),
    ),
    sideEffects: (planned.sideEffects ?? []).map((item) =>
      publicImpact(item, publicIdByEntityId),
    ),
    ...(planned.candidates
      ? {
          candidates: planned.candidates.flatMap((candidate) => {
            const id = publicIdByEntityId.get(candidate.id);
            return id ? [{ ...candidate, id }] : [];
          }),
        }
      : {}),
    generatedAt: now.toISOString(),
  });
};

/**
 * Ids that named nothing live. Reported as an ordinary blocker rather than
 * thrown: this endpoint is deliberately advisory, so it answers "here is what's
 * wrong with what you asked" instead of failing the call. `canProceed` goes
 * false, and `OperationImpact` renders it in the same "Blocked by" section as
 * every planner-emitted blocker, so the bad code lands somewhere visible.
 *
 * `byTargetId` is keyed by the public code itself — for an id that resolved to
 * nothing there is no entity id to key by, which is exactly the point.
 *
 * The codes go in `label`, not just `description`: `ImpactRow` renders only
 * `total`, `label`, and `code`, so a description-only message would be invisible
 * in the UI and this blocker would say "something is unknown" without saying
 * what. `description` still carries the fuller sentence for MCP callers, which
 * receive the whole payload.
 */
const unresolvedBlocker = (entity: string, codes: string[]): ImpactItem => ({
  code: "block-unresolved-target",
  effect: "block",
  label: `unknown ${entity}: ${codes.join(", ")}`,
  description: `No live ${entity} matches ${codes.join(", ")}. The code is well-formed, so it was deleted or never existed.`,
  total: codes.length,
  byTargetId: Object.fromEntries(codes.map((code) => [code, 1])),
});

/**
 * A merge preview with no keeper, for an entity that can't rank candidates.
 * Only `ingredient` answers that question (see the `keepId: undefined` arm);
 * for the rest there is genuinely nothing to compute.
 */
const needsKeeperBlocker = (entity: string): ImpactItem => ({
  code: "block-missing-keeper",
  effect: "block",
  label: "keeper required",
  description: `A ${entity} merge preview needs a keepId — candidate ranking without one is only supported for ingredient.`,
  total: 0,
  byTargetId: {},
});

/**
 * A preview is advisory, so an unmappable target is dropped rather than fatal —
 * see `UnmappedTargetPolicy`. Mutation results must pass `"throw"` instead.
 */
const publicImpact = (
  item: ImpactItem,
  publicIdByEntityId: ReadonlyMap<string, string>,
): PublicImpactItem => toPublicImpact(item, publicIdByEntityId, "drop");
