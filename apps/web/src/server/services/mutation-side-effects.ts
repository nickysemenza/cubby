import type { BackgroundBatchRef } from "@cubby/schemas/background-jobs";
import {
  cookbookId,
  expenseId,
  financialAccountId,
  financialTransactionId,
  imageId,
  ingredientId,
  inventoryId,
  locationId,
  mealId,
  productId,
  projectId,
  purchaseId,
  recipeId,
  taskId,
  vendorId,
  wishId,
} from "@cubby/schemas/identifiers";
import type {
  SearchableEntity,
  SearchableEntityRef,
} from "@cubby/schemas/search";
import { uniqBy } from "es-toolkit";
import { z } from "zod";

import {
  dispatchBackgroundJobs,
  dispatchLocationValuationRecompute,
  dispatchProblemCountsRefresh,
} from "~/server/background-dispatch";
import type { Database } from "~/server/db";
import {
  findCommercialEmbeddingRefsForExpenses,
  findEmbeddingRefsForPurchases,
  findEmbeddingRefsForVendors,
  findInventoryEmbeddingRefsForLocations,
  findInventoryEmbeddingRefsForProducts,
  findMealEmbeddingRefsForRecipes,
  findRecipeEmbeddingRefsForIngredients,
  findTaskEmbeddingRefsForProducts,
  findTrackerEmbeddingRefsForProjects,
  findTransactionEmbeddingRefsForAccounts,
  findWishEmbeddingRefsForProducts,
} from "~/server/repo/entity-embedding";
import {
  refreshSearchDocument,
  refreshSearchDocuments,
} from "~/server/repo/search-document";

const mutationEntityRefSchema = z.discriminatedUnion("entityType", [
  z.object({ entityType: z.literal("product"), entityId: productId }),
  z.object({ entityType: z.literal("location"), entityId: locationId }),
  z.object({ entityType: z.literal("ingredient"), entityId: ingredientId }),
  z.object({ entityType: z.literal("recipe"), entityId: recipeId }),
  z.object({ entityType: z.literal("cookbook"), entityId: cookbookId }),
  z.object({ entityType: z.literal("inventory"), entityId: inventoryId }),
  z.object({ entityType: z.literal("meal"), entityId: mealId }),
  z.object({ entityType: z.literal("project"), entityId: projectId }),
  z.object({ entityType: z.literal("task"), entityId: taskId }),
  z.object({ entityType: z.literal("vendor"), entityId: vendorId }),
  z.object({ entityType: z.literal("purchase"), entityId: purchaseId }),
  z.object({
    entityType: z.literal("financialAccount"),
    entityId: financialAccountId,
  }),
  z.object({
    entityType: z.literal("financialTransaction"),
    entityId: financialTransactionId,
  }),
  z.object({ entityType: z.literal("expense"), entityId: expenseId }),
  z.object({ entityType: z.literal("wish"), entityId: wishId }),
  z.object({ entityType: z.literal("image"), entityId: imageId }),
]);

export const mutationSideEffectEventSchema = z.object({
  action: z.enum(["created", "updated", "deleted"]),
  entity: mutationEntityRefSchema,
  source: z.string().min(1),
  // Gates the location AI refresh: vision analysis only re-runs when images
  // actually changed (see enqueueLocationAiRefresh). Absent ⇒ no AI refresh.
  locationImagesChanged: z.boolean().optional(),
});

export type MutationSideEffectEvent = z.infer<
  typeof mutationSideEffectEventSchema
>;

export interface MutationSideEffectPorts {
  readonly dispatchBackgroundJobs: typeof dispatchBackgroundJobs;
  readonly dispatchLocationValuationRecompute: typeof dispatchLocationValuationRecompute;
  readonly dispatchProblemCountsRefresh: typeof dispatchProblemCountsRefresh;
  readonly findInventoryEmbeddingRefsForProducts: typeof findInventoryEmbeddingRefsForProducts;
  readonly findInventoryEmbeddingRefsForLocations: typeof findInventoryEmbeddingRefsForLocations;
  readonly findRecipeEmbeddingRefsForIngredients: typeof findRecipeEmbeddingRefsForIngredients;
  readonly findTaskEmbeddingRefsForProducts: typeof findTaskEmbeddingRefsForProducts;
  readonly findWishEmbeddingRefsForProducts: typeof findWishEmbeddingRefsForProducts;
  readonly findMealEmbeddingRefsForRecipes: typeof findMealEmbeddingRefsForRecipes;
  readonly findTrackerEmbeddingRefsForProjects: typeof findTrackerEmbeddingRefsForProjects;
  readonly findEmbeddingRefsForVendors: typeof findEmbeddingRefsForVendors;
  readonly findEmbeddingRefsForPurchases: typeof findEmbeddingRefsForPurchases;
  readonly findTransactionEmbeddingRefsForAccounts: typeof findTransactionEmbeddingRefsForAccounts;
  readonly findCommercialEmbeddingRefsForExpenses: typeof findCommercialEmbeddingRefsForExpenses;
  readonly refreshSearchDocument: (
    db: Database,
    entityType: SearchableEntity,
    entityId: string,
  ) => Promise<void>;
  readonly refreshSearchDocuments: (
    db: Database,
    refs: SearchableEntityRef[],
  ) => Promise<void>;
}

const productionMutationSideEffectPorts: MutationSideEffectPorts = {
  dispatchBackgroundJobs,
  dispatchLocationValuationRecompute,
  dispatchProblemCountsRefresh,
  findInventoryEmbeddingRefsForProducts,
  findInventoryEmbeddingRefsForLocations,
  findRecipeEmbeddingRefsForIngredients,
  findTaskEmbeddingRefsForProducts,
  findWishEmbeddingRefsForProducts,
  findMealEmbeddingRefsForRecipes,
  findTrackerEmbeddingRefsForProjects,
  findEmbeddingRefsForVendors,
  findEmbeddingRefsForPurchases,
  findTransactionEmbeddingRefsForAccounts,
  findCommercialEmbeddingRefsForExpenses,
  refreshSearchDocument: async (...args) => {
    await refreshSearchDocument(...args);
  },
  refreshSearchDocuments: async (...args) => {
    await refreshSearchDocuments(...args);
  },
};
type MutationEntityType = MutationSideEffectEvent["entity"]["entityType"];
type MutationAction = MutationSideEffectEvent["action"];

interface HandlerContext {
  db: Database;
  event: MutationSideEffectEvent;
  ports: MutationSideEffectPorts;
}

type MutationSideEffectBatchHandler = (
  ctx: HandlerContext,
) => Promise<BackgroundBatchRef[]>;
type MutationSideEffectManifest = Record<
  MutationEntityType,
  {
    onCreate: MutationSideEffectBatchHandler[];
    onUpdate: MutationSideEffectBatchHandler[];
    onDelete: MutationSideEffectBatchHandler[];
  }
>;

const isSearchableEntity = (
  entityType: MutationEntityType,
): entityType is SearchableEntity => entityType !== "image";

const ownEmbeddingRef = (
  event: MutationSideEffectEvent,
): SearchableEntityRef | null =>
  isSearchableEntity(event.entity.entityType)
    ? {
        entityType: event.entity.entityType,
        entityId: event.entity.entityId,
      }
    : null;

/**
 * Keep the changed entity immediately discoverable without coupling a
 * successful source mutation to the availability of the derived index.
 *
 * The embedding job already queued by the manifest is the repair path when
 * this best-effort synchronous refresh fails, so the committed mutation still
 * returns success instead of reporting a false rollback to the caller.
 */
async function refreshOwnSearchDocument(
  db: Database,
  event: MutationSideEffectEvent,
  ports: MutationSideEffectPorts,
): Promise<void> {
  if (event.action === "deleted") return;
  const ref = ownEmbeddingRef(event);
  if (!ref) return;
  try {
    await ports.refreshSearchDocument(db, ref.entityType, ref.entityId);
  } catch (error) {
    console.error("search.document.sync-refresh.failed", {
      source: event.source,
      action: event.action,
      entityType: ref.entityType,
      entityId: ref.entityId,
      error,
    });
  }
}

async function enqueueEntityEmbeddingRefreshMany(
  db: Database,
  refs: SearchableEntityRef[],
  event: MutationSideEffectEvent,
  ports: MutationSideEffectPorts,
): Promise<BackgroundBatchRef[]> {
  const uniqueRefs = uniqBy(refs, (ref) => `${ref.entityType}:${ref.entityId}`);
  if (uniqueRefs.length === 0) return [];

  const dispatched = await ports.dispatchBackgroundJobs(db, {
    kind: "entity-embedding.refresh",
    source: "mutation",
    metadata: {
      source: event.source,
      action: event.action,
      entity: event.entity,
      refCount: uniqueRefs.length,
    },
    jobs: uniqueRefs.map((ref) => ({
      kind: "entity-embedding.refresh" as const,
      dedupeKey: `entity-embedding.refresh:${ref.entityType}:${ref.entityId}`,
      payload: {
        entityType: ref.entityType,
        entityId: ref.entityId,
      },
    })),
  });
  return [dispatched.batch];
}

// Ref-only variant of each embedding-refresh handler below, factored out so
// runMutationSideEffectsForEntities can collect refs across an entire bulk
// wave and issue ONE enqueueEntityEmbeddingRefreshMany call (one transaction)
// instead of one dispatch per entity — see embeddingRefCollectorByHandler.
type EmbeddingRefCollector = (
  ctx: HandlerContext,
) => Promise<SearchableEntityRef[]>;

const collectOwnEmbeddingRef: EmbeddingRefCollector = async (ctx) => {
  const ref = ownEmbeddingRef(ctx.event);
  return ref ? [ref] : [];
};

const collectInventoryEmbeddingRefsForProduct: EmbeddingRefCollector = async (
  ctx,
) => {
  if (ctx.event.entity.entityType !== "product") return [];
  return await ctx.ports.findInventoryEmbeddingRefsForProducts(ctx.db, [
    ctx.event.entity.entityId,
  ]);
};

const collectTaskEmbeddingRefsForProduct: EmbeddingRefCollector = async (
  ctx,
) => {
  if (ctx.event.entity.entityType !== "product") return [];
  return await ctx.ports.findTaskEmbeddingRefsForProducts(ctx.db, [
    ctx.event.entity.entityId,
  ]);
};

const collectWishEmbeddingRefsForProduct: EmbeddingRefCollector = async (
  ctx,
) => {
  if (ctx.event.entity.entityType !== "product") return [];
  return await ctx.ports.findWishEmbeddingRefsForProducts(ctx.db, [
    ctx.event.entity.entityId,
  ]);
};

const collectInventoryEmbeddingRefsForLocation: EmbeddingRefCollector = async (
  ctx,
) => {
  if (ctx.event.entity.entityType !== "location") return [];
  return await ctx.ports.findInventoryEmbeddingRefsForLocations(ctx.db, [
    ctx.event.entity.entityId,
  ]);
};

const collectRecipeEmbeddingRefsForIngredient: EmbeddingRefCollector = async (
  ctx,
) => {
  if (ctx.event.entity.entityType !== "ingredient") return [];
  return await ctx.ports.findRecipeEmbeddingRefsForIngredients(ctx.db, [
    ctx.event.entity.entityId,
  ]);
};

const collectMealEmbeddingRefsForRecipe: EmbeddingRefCollector = async (
  ctx,
) => {
  if (ctx.event.entity.entityType !== "recipe") return [];
  return await ctx.ports.findMealEmbeddingRefsForRecipes(ctx.db, [
    ctx.event.entity.entityId,
  ]);
};

const collectTrackerEmbeddingRefsForProject: EmbeddingRefCollector = async (
  ctx,
) => {
  if (ctx.event.entity.entityType !== "project") return [];
  return await ctx.ports.findTrackerEmbeddingRefsForProjects(ctx.db, [
    ctx.event.entity.entityId,
  ]);
};

const collectEmbeddingRefsForVendor: EmbeddingRefCollector = async (ctx) => {
  if (ctx.event.entity.entityType !== "vendor") return [];
  return ctx.ports.findEmbeddingRefsForVendors(ctx.db, [
    ctx.event.entity.entityId,
  ]);
};

const collectEmbeddingRefsForPurchase: EmbeddingRefCollector = async (ctx) => {
  if (ctx.event.entity.entityType !== "purchase") return [];
  return ctx.ports.findEmbeddingRefsForPurchases(ctx.db, [
    ctx.event.entity.entityId,
  ]);
};

const collectTransactionEmbeddingRefsForAccount: EmbeddingRefCollector = async (
  ctx,
) => {
  if (ctx.event.entity.entityType !== "financialAccount") return [];
  return ctx.ports.findTransactionEmbeddingRefsForAccounts(ctx.db, [
    ctx.event.entity.entityId,
  ]);
};

const collectCommercialEmbeddingRefsForExpense: EmbeddingRefCollector = async (
  ctx,
) => {
  if (ctx.event.entity.entityType !== "expense") return [];
  return ctx.ports.findCommercialEmbeddingRefsForExpenses(ctx.db, [
    ctx.event.entity.entityId,
  ]);
};

async function refreshOwnEmbedding(
  ctx: HandlerContext,
): Promise<BackgroundBatchRef[]> {
  const refs = await collectOwnEmbeddingRef(ctx);
  return await enqueueEntityEmbeddingRefreshMany(
    ctx.db,
    refs,
    ctx.event,
    ctx.ports,
  );
}

// NOTE: there is no onDelete embedding handler. Embedding soft-delete is
// cascaded at the repo delete layer (`cascadeRemoval` inside each entity's
// deleteXxx transaction), so it covers ALL delete callers — including
// direct repo deletes that skip this side-effect pipeline (e.g.
// problems.service.deleteUnusedIngredients). Re-adding it here would be a
// redundant higher-layer duplicate.

async function refreshInventoryEmbeddingsForProduct(
  ctx: HandlerContext,
): Promise<BackgroundBatchRef[]> {
  const refs = await collectInventoryEmbeddingRefsForProduct(ctx);
  return await enqueueEntityEmbeddingRefreshMany(
    ctx.db,
    refs,
    ctx.event,
    ctx.ports,
  );
}

async function refreshTaskEmbeddingsForProduct(
  ctx: HandlerContext,
): Promise<BackgroundBatchRef[]> {
  const refs = await collectTaskEmbeddingRefsForProduct(ctx);
  return await enqueueEntityEmbeddingRefreshMany(
    ctx.db,
    refs,
    ctx.event,
    ctx.ports,
  );
}

async function refreshWishEmbeddingsForProduct(
  ctx: HandlerContext,
): Promise<BackgroundBatchRef[]> {
  const refs = await collectWishEmbeddingRefsForProduct(ctx);
  return await enqueueEntityEmbeddingRefreshMany(
    ctx.db,
    refs,
    ctx.event,
    ctx.ports,
  );
}

async function refreshInventoryEmbeddingsForLocation(
  ctx: HandlerContext,
): Promise<BackgroundBatchRef[]> {
  const refs = await collectInventoryEmbeddingRefsForLocation(ctx);
  return await enqueueEntityEmbeddingRefreshMany(
    ctx.db,
    refs,
    ctx.event,
    ctx.ports,
  );
}

async function refreshRecipeEmbeddingsForIngredient(
  ctx: HandlerContext,
): Promise<BackgroundBatchRef[]> {
  const refs = await collectRecipeEmbeddingRefsForIngredient(ctx);
  return await enqueueEntityEmbeddingRefreshMany(
    ctx.db,
    refs,
    ctx.event,
    ctx.ports,
  );
}

// Meals embed their planned recipes' names, so a recipe update fans out.
async function refreshMealEmbeddingsForRecipe(
  ctx: HandlerContext,
): Promise<BackgroundBatchRef[]> {
  const refs = await collectMealEmbeddingRefsForRecipe(ctx);
  return await enqueueEntityEmbeddingRefreshMany(
    ctx.db,
    refs,
    ctx.event,
    ctx.ports,
  );
}

// Tasks/expenses embed their project's name, so a project update fans out.
async function refreshTrackerEmbeddingsForProject(
  ctx: HandlerContext,
): Promise<BackgroundBatchRef[]> {
  const refs = await collectTrackerEmbeddingRefsForProject(ctx);
  return await enqueueEntityEmbeddingRefreshMany(
    ctx.db,
    refs,
    ctx.event,
    ctx.ports,
  );
}

async function refreshEmbeddingsForVendor(
  ctx: HandlerContext,
): Promise<BackgroundBatchRef[]> {
  const refs = await collectEmbeddingRefsForVendor(ctx);
  return enqueueEntityEmbeddingRefreshMany(ctx.db, refs, ctx.event, ctx.ports);
}

async function refreshEmbeddingsForPurchase(
  ctx: HandlerContext,
): Promise<BackgroundBatchRef[]> {
  const refs = await collectEmbeddingRefsForPurchase(ctx);
  return enqueueEntityEmbeddingRefreshMany(ctx.db, refs, ctx.event, ctx.ports);
}

async function refreshTransactionEmbeddingsForAccount(
  ctx: HandlerContext,
): Promise<BackgroundBatchRef[]> {
  const refs = await collectTransactionEmbeddingRefsForAccount(ctx);
  return enqueueEntityEmbeddingRefreshMany(ctx.db, refs, ctx.event, ctx.ports);
}

async function refreshCommercialEmbeddingsForExpense(
  ctx: HandlerContext,
): Promise<BackgroundBatchRef[]> {
  const refs = await collectCommercialEmbeddingRefsForExpense(ctx);
  return enqueueEntityEmbeddingRefreshMany(ctx.db, refs, ctx.event, ctx.ports);
}

// Maps each embedding-refresh handler to its ref-only collector, so the bulk
// path (runMutationSideEffectsForEntities) can bypass the handler's own
// per-event dispatch and instead accumulate refs for one wave-wide dispatch.
const embeddingRefCollectorByHandler = new Map<
  MutationSideEffectBatchHandler,
  EmbeddingRefCollector
>([
  [refreshOwnEmbedding, collectOwnEmbeddingRef],
  [
    refreshInventoryEmbeddingsForProduct,
    collectInventoryEmbeddingRefsForProduct,
  ],
  [refreshTaskEmbeddingsForProduct, collectTaskEmbeddingRefsForProduct],
  [refreshWishEmbeddingsForProduct, collectWishEmbeddingRefsForProduct],
  [
    refreshInventoryEmbeddingsForLocation,
    collectInventoryEmbeddingRefsForLocation,
  ],
  [
    refreshRecipeEmbeddingsForIngredient,
    collectRecipeEmbeddingRefsForIngredient,
  ],
  [refreshMealEmbeddingsForRecipe, collectMealEmbeddingRefsForRecipe],
  [refreshTrackerEmbeddingsForProject, collectTrackerEmbeddingRefsForProject],
  [refreshEmbeddingsForVendor, collectEmbeddingRefsForVendor],
  [refreshEmbeddingsForPurchase, collectEmbeddingRefsForPurchase],
  [
    refreshTransactionEmbeddingsForAccount,
    collectTransactionEmbeddingRefsForAccount,
  ],
  [
    refreshCommercialEmbeddingsForExpense,
    collectCommercialEmbeddingRefsForExpense,
  ],
]);

async function enqueueLocationAiRefresh(
  ctx: HandlerContext,
): Promise<BackgroundBatchRef[]> {
  if (ctx.event.entity.entityType !== "location") return [];
  if (ctx.event.source.startsWith("location-ai.")) return [];
  // The analysis fingerprint includes the location name, so a rename would force
  // a cache miss and fire two Anthropic vision calls (description + inventory
  // detection) for no benefit. Only refresh when images actually changed.
  if (!ctx.event.locationImagesChanged) return [];
  const locationIdValue = ctx.event.entity.entityId;
  const batches: BackgroundBatchRef[] = [];
  for (const kind of [
    "location-ai.description.refresh",
    "location-ai.inventory.refresh",
  ] as const) {
    const dispatched = await ctx.ports.dispatchBackgroundJobs(ctx.db, {
      kind,
      source: "mutation",
      metadata: {
        source: ctx.event.source,
        action: ctx.event.action,
        entity: ctx.event.entity,
      },
      jobs: [
        {
          kind,
          dedupeKey: `${kind}:${locationIdValue}`,
          payload: { locationId: locationIdValue },
        },
      ],
    });
    batches.push(dispatched.batch);
  }
  return batches;
}

// These side effects are intentionally coarse. Cubby data changes are low-volume,
// and background jobs are idempotent: embeddings skip unchanged text by hash and
// AI analyses skip unchanged fingerprints. Prefer obvious coverage over fragile
// changed-field detection.
//
// Location valuation is NOT a per-entity handler here: it is a whole-tree
// recompute, so it is enqueued once per mutation wave (see needsValuationRecompute
// + the run* functions) rather than per affected entity.
export const mutationSideEffectManifest = {
  product: {
    onCreate: [refreshOwnEmbedding, refreshInventoryEmbeddingsForProduct],
    onUpdate: [
      refreshOwnEmbedding,
      refreshInventoryEmbeddingsForProduct,
      refreshTaskEmbeddingsForProduct,
      refreshWishEmbeddingsForProduct,
    ],
    onDelete: [],
  },
  location: {
    // enqueueLocationAiRefresh also runs onCreate: a location created WITH
    // photos must generate its description/inventory analysis (gated by
    // locationImagesChanged), else it's born with a NULL aiDescription.
    onCreate: [refreshOwnEmbedding, enqueueLocationAiRefresh],
    onUpdate: [
      refreshOwnEmbedding,
      refreshInventoryEmbeddingsForLocation,
      enqueueLocationAiRefresh,
    ],
    onDelete: [],
  },
  ingredient: {
    onCreate: [refreshOwnEmbedding],
    onUpdate: [refreshOwnEmbedding, refreshRecipeEmbeddingsForIngredient],
    onDelete: [],
  },
  recipe: {
    onCreate: [refreshOwnEmbedding],
    // Rename fan-out: meal embeddings include their planned recipes' names.
    onUpdate: [refreshOwnEmbedding, refreshMealEmbeddingsForRecipe],
    onDelete: [],
  },
  cookbook: {
    onCreate: [refreshOwnEmbedding],
    onUpdate: [refreshOwnEmbedding],
    onDelete: [],
  },
  inventory: {
    onCreate: [refreshOwnEmbedding],
    onUpdate: [refreshOwnEmbedding],
    onDelete: [],
  },
  meal: {
    onCreate: [refreshOwnEmbedding],
    onUpdate: [refreshOwnEmbedding],
    onDelete: [],
  },
  project: {
    onCreate: [refreshOwnEmbedding],
    // Rename fan-out: task/expense embeddings include the project name.
    onUpdate: [refreshOwnEmbedding, refreshTrackerEmbeddingsForProject],
    onDelete: [],
  },
  task: {
    onCreate: [refreshOwnEmbedding],
    onUpdate: [refreshOwnEmbedding],
    onDelete: [],
  },
  vendor: {
    onCreate: [refreshOwnEmbedding],
    onUpdate: [refreshOwnEmbedding, refreshEmbeddingsForVendor],
    onDelete: [],
  },
  purchase: {
    onCreate: [refreshOwnEmbedding],
    onUpdate: [refreshOwnEmbedding, refreshEmbeddingsForPurchase],
    onDelete: [],
  },
  financialAccount: {
    onCreate: [refreshOwnEmbedding],
    onUpdate: [refreshOwnEmbedding, refreshTransactionEmbeddingsForAccount],
    onDelete: [],
  },
  financialTransaction: {
    onCreate: [refreshOwnEmbedding],
    onUpdate: [refreshOwnEmbedding],
    onDelete: [],
  },
  expense: {
    onCreate: [refreshOwnEmbedding, refreshCommercialEmbeddingsForExpense],
    onUpdate: [refreshOwnEmbedding, refreshCommercialEmbeddingsForExpense],
    onDelete: [],
  },
  wish: {
    onCreate: [refreshOwnEmbedding],
    onUpdate: [refreshOwnEmbedding],
    onDelete: [],
  },
  image: {
    onCreate: [],
    onUpdate: [],
    onDelete: [],
  },
} satisfies MutationSideEffectManifest;

// Whole-tree location valuation must run whenever inventory changes, a product's
// price/details change, or a location is created/changed/removed.
//
// `created` counts because a location can now BE a product: a new linked
// location adds its SKU's price to its parent's container bucket the moment it
// exists. Before `location.productId`, a fresh location was always empty and
// could not move any number, which is why creation used to be exempt.
function needsValuationRecompute(event: MutationSideEffectEvent): boolean {
  switch (event.entity.entityType) {
    case "inventory":
      return true;
    case "product":
      return event.action === "updated";
    case "location":
      return (
        event.action === "created" ||
        event.action === "updated" ||
        event.action === "deleted"
      );
    default:
      return false;
  }
}

const handlersFor = (
  event: MutationSideEffectEvent,
): MutationSideEffectBatchHandler[] => {
  const manifest = mutationSideEffectManifest[event.entity.entityType];
  const key = (
    {
      created: "onCreate",
      updated: "onUpdate",
      deleted: "onDelete",
    } satisfies Record<MutationAction, keyof typeof manifest>
  )[event.action];
  return manifest[key];
};

async function runManifestHandlers(
  db: Database,
  event: MutationSideEffectEvent,
  ports: MutationSideEffectPorts,
): Promise<BackgroundBatchRef[]> {
  const handlers = handlersFor(event);
  const batches: BackgroundBatchRef[] = [];
  for (const handler of handlers) {
    batches.push(...(await handler({ db, event, ports })));
  }
  return batches;
}

/**
 * Problem counts are a derived, stale-safe snapshot. A failed refresh enqueue
 * must not turn an already-committed entity mutation into an apparent failure;
 * the daily safety refresh remains the repair path.
 */
async function enqueueProblemCountsRefreshBestEffort(
  db: Database,
  source: string,
  ports: MutationSideEffectPorts,
): Promise<BackgroundBatchRef | null> {
  try {
    const dispatched = await ports.dispatchProblemCountsRefresh(
      db,
      "mutation",
      source,
    );
    return dispatched?.batch ?? null;
  } catch (error) {
    console.error("problems.counts.refresh.enqueue.failed", {
      source,
      error,
    });
    return null;
  }
}

export async function runMutationSideEffects(
  db: Database,
  event: MutationSideEffectEvent,
  ports: MutationSideEffectPorts = productionMutationSideEffectPorts,
): Promise<BackgroundBatchRef[]> {
  const parsed = mutationSideEffectEventSchema.parse(event);
  await refreshOwnSearchDocument(db, parsed, ports);
  const batches = await runManifestHandlers(db, parsed, ports);
  if (needsValuationRecompute(parsed)) {
    const dispatched = await ports.dispatchLocationValuationRecompute(
      db,
      parsed.source,
    );
    batches.push(dispatched.batch);
  }
  const problemCounts = await enqueueProblemCountsRefreshBestEffort(
    db,
    parsed.source,
    ports,
  );
  if (problemCounts) batches.push(problemCounts);
  return batches;
}

export async function runMutationSideEffectsForEntities(
  db: Database,
  events: MutationSideEffectEvent[],
  ports: MutationSideEffectPorts = productionMutationSideEffectPorts,
): Promise<BackgroundBatchRef[]> {
  const parsed = events.map((event) =>
    mutationSideEffectEventSchema.parse(event),
  );
  const ownSearchRefs = uniqBy(
    parsed.flatMap((event) => {
      if (event.action === "deleted") return [];
      const ref = ownEmbeddingRef(event);
      return ref ? [ref] : [];
    }),
    (ref) => `${ref.entityType}:${ref.entityId}`,
  );
  if (ownSearchRefs.length > 0) {
    try {
      await ports.refreshSearchDocuments(db, ownSearchRefs);
    } catch (error) {
      console.error("search.document.bulk-sync-refresh.failed", {
        refCount: ownSearchRefs.length,
        source: parsed[0]?.source ?? "mutation.bulk",
        error,
      });
    }
  }
  const batches: BackgroundBatchRef[] = [];
  // Embedding-refresh handlers all funnel into the same job kind, so their
  // refs are collected across the whole wave and dispatched once below
  // instead of once per entity (was N transactions for N entities).
  const waveEmbeddingRefs: SearchableEntityRef[] = [];
  for (const event of parsed) {
    for (const handler of handlersFor(event)) {
      const collector = embeddingRefCollectorByHandler.get(handler);
      if (collector) {
        waveEmbeddingRefs.push(...(await collector({ db, event, ports })));
        continue;
      }
      batches.push(...(await handler({ db, event, ports })));
    }
  }
  const firstEvent = parsed[0];
  if (waveEmbeddingRefs.length > 0 && firstEvent) {
    batches.push(
      ...(await enqueueEntityEmbeddingRefreshMany(
        db,
        waveEmbeddingRefs,
        firstEvent,
        ports,
      )),
    );
  }
  // Valuation is whole-tree, so a bulk wave needs exactly one recompute, not one
  // per entity (the previous per-entity fan-out ran N whole-tree recomputes).
  if (parsed.some(needsValuationRecompute)) {
    const dispatched = await ports.dispatchLocationValuationRecompute(
      db,
      parsed[0]?.source ?? "mutation.bulk",
    );
    batches.push(dispatched.batch);
  }
  if (parsed.length > 0) {
    const problemCounts = await enqueueProblemCountsRefreshBestEffort(
      db,
      parsed[0]?.source ?? "mutation.bulk",
      ports,
    );
    if (problemCounts) batches.push(problemCounts);
  }
  return batches;
}
