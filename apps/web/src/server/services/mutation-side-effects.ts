import type { BackgroundTaskInput } from "@cubby/schemas/background-tasks";
import type { EntityId, EntityRef } from "@cubby/schemas/identifiers";
import {
  isEmbeddableEntity,
  type SearchableEntity,
  type SearchableEntityRef,
} from "@cubby/schemas/search";
import { uniqBy } from "es-toolkit";

import {
  type PublishOptions,
  publishInBackground,
} from "~/server/background-tasks/publish";
import type { Database, DrizzleTransaction } from "~/server/db";
import {
  findCommercialEmbeddingRefsForExpenses,
  findEmbeddingRefsForPurchases,
  findEmbeddingRefsForVendors,
  findGardenEntryEmbeddingRefsForLocations,
  findGardenEntryEmbeddingRefsForPlantings,
  findInventoryEmbeddingRefsForLocations,
  findInventoryEmbeddingRefsForProducts,
  findMealEmbeddingRefsForRecipes,
  findPlantingEmbeddingRefsForIngredients,
  findPlantingEmbeddingRefsForLocations,
  findRecipeEmbeddingRefsForIngredients,
  findTaskEmbeddingRefsForProducts,
  findTrackerEmbeddingRefsForProjects,
  findTransactionEmbeddingRefsForAccounts,
  findWishEmbeddingRefsForProducts,
} from "~/server/repo/entity-embedding";
import {
  findDirectImageSearchOwnerRefs,
  refreshSearchDocuments,
} from "~/server/repo/search-document";

const mutationSideEffectEntities = [
  "product",
  "location",
  "ingredient",
  "recipe",
  "cookbook",
  "inventory",
  "meal",
  "project",
  "task",
  "vendor",
  "purchase",
  "financialAccount",
  "financialTransaction",
  "expense",
  "wish",
  "planting",
  "gardenEntry",
  "image",
] as const;

export type MutationSideEffectEntity =
  (typeof mutationSideEffectEntities)[number];
export type MutationSideEffectEntityRef = EntityRef<MutationSideEffectEntity>;

export type MutationSideEffectEvent = {
  action: "created" | "updated" | "deleted";
  entity: MutationSideEffectEntityRef;
  source: string;
  // Gates the location AI refresh: vision analysis only re-runs when images
  // actually changed (see enqueueLocationAiRefresh). Absent ⇒ no AI refresh.
  locationImagesChanged?: boolean;
};

const mutationSideEffectEntitySet = new Set<string>(mutationSideEffectEntities);

export const isMutationSideEffectEntity = (
  entity: string,
): entity is MutationSideEffectEntity =>
  mutationSideEffectEntitySet.has(entity);

export const isMutationSideEffectRef = (
  ref: EntityRef,
): ref is MutationSideEffectEntityRef => isMutationSideEffectEntity(ref.entity);

export interface MutationSideEffectPorts {
  /** Publish after commit; failures are reported, never surfaced as rollback. */
  readonly publishTasks: (
    db: Database,
    tasks: readonly BackgroundTaskInput[],
    options: PublishOptions,
  ) => Promise<void>;
  readonly findInventoryEmbeddingRefsForProducts: typeof findInventoryEmbeddingRefsForProducts;
  readonly findInventoryEmbeddingRefsForLocations: typeof findInventoryEmbeddingRefsForLocations;
  readonly findRecipeEmbeddingRefsForIngredients: typeof findRecipeEmbeddingRefsForIngredients;
  readonly findTaskEmbeddingRefsForProducts: typeof findTaskEmbeddingRefsForProducts;
  readonly findWishEmbeddingRefsForProducts: typeof findWishEmbeddingRefsForProducts;
  readonly findMealEmbeddingRefsForRecipes: typeof findMealEmbeddingRefsForRecipes;
  readonly findPlantingEmbeddingRefsForIngredients: typeof findPlantingEmbeddingRefsForIngredients;
  readonly findPlantingEmbeddingRefsForLocations: typeof findPlantingEmbeddingRefsForLocations;
  readonly findGardenEntryEmbeddingRefsForLocations: typeof findGardenEntryEmbeddingRefsForLocations;
  readonly findGardenEntryEmbeddingRefsForPlantings: typeof findGardenEntryEmbeddingRefsForPlantings;
  readonly findTrackerEmbeddingRefsForProjects: typeof findTrackerEmbeddingRefsForProjects;
  readonly findEmbeddingRefsForVendors: typeof findEmbeddingRefsForVendors;
  readonly findEmbeddingRefsForPurchases: typeof findEmbeddingRefsForPurchases;
  readonly findTransactionEmbeddingRefsForAccounts: typeof findTransactionEmbeddingRefsForAccounts;
  readonly findCommercialEmbeddingRefsForExpenses: typeof findCommercialEmbeddingRefsForExpenses;
  readonly findDirectImageSearchOwnerRefs: typeof findDirectImageSearchOwnerRefs;
  readonly refreshSearchDocuments: (
    db: Database | DrizzleTransaction,
    refs: SearchableEntityRef[],
  ) => Promise<void>;
}

const productionMutationSideEffectPorts: MutationSideEffectPorts = {
  publishTasks: publishInBackground,
  findInventoryEmbeddingRefsForProducts,
  findInventoryEmbeddingRefsForLocations,
  findRecipeEmbeddingRefsForIngredients,
  findTaskEmbeddingRefsForProducts,
  findWishEmbeddingRefsForProducts,
  findMealEmbeddingRefsForRecipes,
  findPlantingEmbeddingRefsForIngredients,
  findPlantingEmbeddingRefsForLocations,
  findGardenEntryEmbeddingRefsForLocations,
  findGardenEntryEmbeddingRefsForPlantings,
  findTrackerEmbeddingRefsForProjects,
  findEmbeddingRefsForVendors,
  findEmbeddingRefsForPurchases,
  findTransactionEmbeddingRefsForAccounts,
  findCommercialEmbeddingRefsForExpenses,
  findDirectImageSearchOwnerRefs,
  refreshSearchDocuments: async (...args) => {
    await refreshSearchDocuments(...args);
  },
};

export { productionMutationSideEffectPorts };
type MutationEntityType = MutationSideEffectEvent["entity"]["entity"];
type MutationAction = MutationSideEffectEvent["action"];

/** Post-commit handlers publish, so they always hold the request Database. */
interface HandlerContext {
  db: Database;
  event: MutationSideEffectEvent;
  ports: MutationSideEffectPorts;
}

/** Ref collectors also run inside the write transaction. */
interface CollectorContext {
  db: Database | DrizzleTransaction;
  event: MutationSideEffectEvent;
  ports: MutationSideEffectPorts;
}

type MutationSideEffectHandler = (ctx: HandlerContext) => Promise<void>;
type MutationSideEffectManifest = Record<
  MutationEntityType,
  {
    onCreate: MutationSideEffectHandler[];
    onUpdate: MutationSideEffectHandler[];
    onDelete: MutationSideEffectHandler[];
  }
>;

const isSearchableEntity = (
  entityType: MutationEntityType,
): entityType is SearchableEntity => entityType !== "image";

const ownEmbeddingRef = (
  event: MutationSideEffectEvent,
): SearchableEntityRef | null =>
  isSearchableEntity(event.entity.entity)
    ? {
        entityType: event.entity.entity,
        entityId: event.entity.id,
      }
    : null;

/**
 * Every search document this event changes: the entity's own projection plus
 * the projections that embed its text (a product rename rewrites its
 * inventory, task, and wish documents). The entity kernel refreshes these
 * inside the write transaction; other writers refresh them synchronously
 * before responding. Either way a projection failure is a visible error, not
 * a swallowed log — the projection is a SQL view of the row being written and
 * has no reason to fail independently.
 */
export async function collectProjectionRefs(
  db: Database | DrizzleTransaction,
  event: MutationSideEffectEvent,
  ports: MutationSideEffectPorts = productionMutationSideEffectPorts,
): Promise<SearchableEntityRef[]> {
  if (event.action === "deleted") return [];
  const refs: SearchableEntityRef[] = [];
  for (const handler of handlersFor(event)) {
    const collector = embeddingRefCollectorByHandler.get(handler);
    if (collector) refs.push(...(await collector({ db, event, ports })));
  }
  return uniqBy(refs, (ref) => `${ref.entityType}:${ref.entityId}`);
}

/** Refresh every projection {@link collectProjectionRefs} names, on `db`. */
export async function refreshProjectionsForEvent(
  db: Database | DrizzleTransaction,
  event: MutationSideEffectEvent,
  ports: MutationSideEffectPorts = productionMutationSideEffectPorts,
): Promise<void> {
  const refs = await collectProjectionRefs(db, event, ports);
  if (refs.length > 0) await ports.refreshSearchDocuments(db, refs);
}

async function publishEmbeddingRefreshes(
  db: Database,
  refs: SearchableEntityRef[],
  cause: Pick<MutationSideEffectEvent, "source"> &
    Partial<Pick<MutationSideEffectEvent, "action">>,
  ports: MutationSideEffectPorts,
): Promise<void> {
  // Purchase/financialTransaction/expense are searchable but not embeddable
  // (see `entity-manifest.ts` `embeddableEntities`): never queue a vector
  // refresh for them, even though they can appear in a collected ref set.
  const embeddableRefs = refs.filter((ref) =>
    isEmbeddableEntity(ref.entityType),
  );
  const uniqueRefs = uniqBy(
    embeddableRefs,
    (ref) => `${ref.entityType}:${ref.entityId}`,
  );
  if (uniqueRefs.length === 0) return;
  const requestedAt = new Date().toISOString();
  await ports.publishTasks(
    db,
    uniqueRefs.map((ref) => ({
      kind: "entity-embedding.refresh" as const,
      requestedAt,
      entityType: ref.entityType,
      entityId: ref.entityId,
    })),
    {
      source: cause.action ? `${cause.source}:${cause.action}` : cause.source,
    },
  );
}

/**
 * Refresh known denormalized search projections after a relationship change.
 * The caller supplies the affected refs captured before the relationship is
 * removed, so no fake mutation event or domain-row update is needed.
 */
export async function refreshDerivedSearchRefs(
  db: Database,
  refs: SearchableEntityRef[],
  source: string,
  ports: MutationSideEffectPorts = productionMutationSideEffectPorts,
): Promise<void> {
  const uniqueRefs = uniqBy(refs, (ref) => `${ref.entityType}:${ref.entityId}`);
  if (uniqueRefs.length === 0) return;
  await ports.refreshSearchDocuments(db, uniqueRefs);
  await publishEmbeddingRefreshes(db, uniqueRefs, { source }, ports);
}

// Ref-only variant of each embedding-refresh handler below, factored out so
// runMutationSideEffectsForEntities can collect refs across an entire bulk
// wave and issue ONE publishEmbeddingRefreshes call (one transaction)
// instead of one dispatch per entity — see embeddingRefCollectorByHandler.
type EmbeddingRefCollector = (
  ctx: CollectorContext,
) => Promise<SearchableEntityRef[]>;

const collectOwnEmbeddingRef: EmbeddingRefCollector = async (ctx) => {
  const ref = ownEmbeddingRef(ctx.event);
  return ref ? [ref] : [];
};

const collectInventoryEmbeddingRefsForProduct: EmbeddingRefCollector = async (
  ctx,
) => {
  if (ctx.event.entity.entity !== "product") return [];
  return await ctx.ports.findInventoryEmbeddingRefsForProducts(ctx.db, [
    ctx.event.entity.id,
  ]);
};

const collectTaskEmbeddingRefsForProduct: EmbeddingRefCollector = async (
  ctx,
) => {
  if (ctx.event.entity.entity !== "product") return [];
  return await ctx.ports.findTaskEmbeddingRefsForProducts(ctx.db, [
    ctx.event.entity.id,
  ]);
};

const collectWishEmbeddingRefsForProduct: EmbeddingRefCollector = async (
  ctx,
) => {
  if (ctx.event.entity.entity !== "product") return [];
  return await ctx.ports.findWishEmbeddingRefsForProducts(ctx.db, [
    ctx.event.entity.id,
  ]);
};

const collectInventoryEmbeddingRefsForLocation: EmbeddingRefCollector = async (
  ctx,
) => {
  if (ctx.event.entity.entity !== "location") return [];
  return await ctx.ports.findInventoryEmbeddingRefsForLocations(ctx.db, [
    ctx.event.entity.id,
  ]);
};

const collectRecipeEmbeddingRefsForIngredient: EmbeddingRefCollector = async (
  ctx,
) => {
  if (ctx.event.entity.entity !== "ingredient") return [];
  return await ctx.ports.findRecipeEmbeddingRefsForIngredients(ctx.db, [
    ctx.event.entity.id,
  ]);
};

const collectMealEmbeddingRefsForRecipe: EmbeddingRefCollector = async (
  ctx,
) => {
  if (ctx.event.entity.entity !== "recipe") return [];
  return await ctx.ports.findMealEmbeddingRefsForRecipes(ctx.db, [
    ctx.event.entity.id,
  ]);
};

const collectPlantingEmbeddingRefsForIngredient: EmbeddingRefCollector = async (
  ctx,
) => {
  if (ctx.event.entity.entity !== "ingredient") return [];
  return await ctx.ports.findPlantingEmbeddingRefsForIngredients(ctx.db, [
    ctx.event.entity.id,
  ]);
};

const collectPlantingEmbeddingRefsForLocation: EmbeddingRefCollector = async (
  ctx,
) => {
  if (ctx.event.entity.entity !== "location") return [];
  return await ctx.ports.findPlantingEmbeddingRefsForLocations(ctx.db, [
    ctx.event.entity.id,
  ]);
};

const collectGardenEntryEmbeddingRefsForLocation: EmbeddingRefCollector =
  async (ctx) => {
    if (ctx.event.entity.entity !== "location") return [];
    return await ctx.ports.findGardenEntryEmbeddingRefsForLocations(ctx.db, [
      ctx.event.entity.id,
    ]);
  };

const collectGardenEntryEmbeddingRefsForPlanting: EmbeddingRefCollector =
  async (ctx) => {
    if (ctx.event.entity.entity !== "planting") return [];
    return await ctx.ports.findGardenEntryEmbeddingRefsForPlantings(ctx.db, [
      ctx.event.entity.id,
    ]);
  };

const collectTrackerEmbeddingRefsForProject: EmbeddingRefCollector = async (
  ctx,
) => {
  if (ctx.event.entity.entity !== "project") return [];
  return await ctx.ports.findTrackerEmbeddingRefsForProjects(ctx.db, [
    ctx.event.entity.id,
  ]);
};

const collectEmbeddingRefsForVendor: EmbeddingRefCollector = async (ctx) => {
  if (ctx.event.entity.entity !== "vendor") return [];
  return ctx.ports.findEmbeddingRefsForVendors(ctx.db, [ctx.event.entity.id]);
};

const collectEmbeddingRefsForPurchase: EmbeddingRefCollector = async (ctx) => {
  if (ctx.event.entity.entity !== "purchase") return [];
  return ctx.ports.findEmbeddingRefsForPurchases(ctx.db, [ctx.event.entity.id]);
};

const collectTransactionEmbeddingRefsForAccount: EmbeddingRefCollector = async (
  ctx,
) => {
  if (ctx.event.entity.entity !== "financialAccount") return [];
  return ctx.ports.findTransactionEmbeddingRefsForAccounts(ctx.db, [
    ctx.event.entity.id,
  ]);
};

const collectCommercialEmbeddingRefsForExpense: EmbeddingRefCollector = async (
  ctx,
) => {
  if (ctx.event.entity.entity !== "expense") return [];
  return ctx.ports.findCommercialEmbeddingRefsForExpenses(ctx.db, [
    ctx.event.entity.id,
  ]);
};

/** Image metadata and derived text affect only its direct owners. */
const collectDirectImageSearchOwnerRefs: EmbeddingRefCollector = async (
  ctx,
) => {
  if (ctx.event.entity.entity !== "image") return [];
  return await ctx.ports.findDirectImageSearchOwnerRefs(
    ctx.db,
    ctx.event.entity.id,
  );
};

async function refreshOwnEmbedding(ctx: HandlerContext): Promise<void> {
  const refs = await collectOwnEmbeddingRef(ctx);
  return await publishEmbeddingRefreshes(ctx.db, refs, ctx.event, ctx.ports);
}

// NOTE: there is no onDelete embedding handler. Embedding soft-delete is
// cascaded at the repo delete layer (`cascadeRemoval` inside each entity's
// deleteXxx transaction), so it covers ALL delete callers — including
// direct repo deletes that skip this side-effect pipeline (e.g.
// problems.service.deleteUnusedIngredients). Re-adding it here would be a
// redundant higher-layer duplicate.

async function refreshInventoryEmbeddingsForProduct(
  ctx: HandlerContext,
): Promise<void> {
  const refs = await collectInventoryEmbeddingRefsForProduct(ctx);
  return await publishEmbeddingRefreshes(ctx.db, refs, ctx.event, ctx.ports);
}

async function refreshTaskEmbeddingsForProduct(
  ctx: HandlerContext,
): Promise<void> {
  const refs = await collectTaskEmbeddingRefsForProduct(ctx);
  return await publishEmbeddingRefreshes(ctx.db, refs, ctx.event, ctx.ports);
}

async function refreshWishEmbeddingsForProduct(
  ctx: HandlerContext,
): Promise<void> {
  const refs = await collectWishEmbeddingRefsForProduct(ctx);
  return await publishEmbeddingRefreshes(ctx.db, refs, ctx.event, ctx.ports);
}

async function refreshInventoryEmbeddingsForLocation(
  ctx: HandlerContext,
): Promise<void> {
  const refs = await collectInventoryEmbeddingRefsForLocation(ctx);
  return await publishEmbeddingRefreshes(ctx.db, refs, ctx.event, ctx.ports);
}

async function refreshRecipeEmbeddingsForIngredient(
  ctx: HandlerContext,
): Promise<void> {
  const refs = await collectRecipeEmbeddingRefsForIngredient(ctx);
  return await publishEmbeddingRefreshes(ctx.db, refs, ctx.event, ctx.ports);
}

// Meals embed their planned recipes' names, so a recipe update fans out.
async function refreshMealEmbeddingsForRecipe(
  ctx: HandlerContext,
): Promise<void> {
  const refs = await collectMealEmbeddingRefsForRecipe(ctx);
  return await publishEmbeddingRefreshes(ctx.db, refs, ctx.event, ctx.ports);
}

// Plantings embed their ingredient's name, so an ingredient rename fans out.
async function refreshPlantingEmbeddingsForIngredient(
  ctx: HandlerContext,
): Promise<void> {
  const refs = await collectPlantingEmbeddingRefsForIngredient(ctx);
  return await publishEmbeddingRefreshes(ctx.db, refs, ctx.event, ctx.ports);
}

// Plantings embed their current location's name (the title's subtitle), and
// garden entries embed their location's name IN the title, so a location
// rename fans out to both.
async function refreshPlantingEmbeddingsForLocation(
  ctx: HandlerContext,
): Promise<void> {
  const refs = await collectPlantingEmbeddingRefsForLocation(ctx);
  return await publishEmbeddingRefreshes(ctx.db, refs, ctx.event, ctx.ports);
}

async function refreshGardenEntryEmbeddingsForLocation(
  ctx: HandlerContext,
): Promise<void> {
  const refs = await collectGardenEntryEmbeddingRefsForLocation(ctx);
  return await publishEmbeddingRefreshes(ctx.db, refs, ctx.event, ctx.ports);
}

async function refreshGardenEntryEmbeddingsForPlanting(
  ctx: HandlerContext,
): Promise<void> {
  const refs = await collectGardenEntryEmbeddingRefsForPlanting(ctx);
  return await publishEmbeddingRefreshes(ctx.db, refs, ctx.event, ctx.ports);
}

// Tasks/expenses embed their project's name, so a project update fans out.
async function refreshTrackerEmbeddingsForProject(
  ctx: HandlerContext,
): Promise<void> {
  const refs = await collectTrackerEmbeddingRefsForProject(ctx);
  return await publishEmbeddingRefreshes(ctx.db, refs, ctx.event, ctx.ports);
}

async function refreshEmbeddingsForVendor(ctx: HandlerContext): Promise<void> {
  const refs = await collectEmbeddingRefsForVendor(ctx);
  return publishEmbeddingRefreshes(ctx.db, refs, ctx.event, ctx.ports);
}

async function refreshEmbeddingsForPurchase(
  ctx: HandlerContext,
): Promise<void> {
  const refs = await collectEmbeddingRefsForPurchase(ctx);
  return publishEmbeddingRefreshes(ctx.db, refs, ctx.event, ctx.ports);
}

async function refreshTransactionEmbeddingsForAccount(
  ctx: HandlerContext,
): Promise<void> {
  const refs = await collectTransactionEmbeddingRefsForAccount(ctx);
  return publishEmbeddingRefreshes(ctx.db, refs, ctx.event, ctx.ports);
}

async function refreshCommercialEmbeddingsForExpense(
  ctx: HandlerContext,
): Promise<void> {
  const refs = await collectCommercialEmbeddingRefsForExpense(ctx);
  return publishEmbeddingRefreshes(ctx.db, refs, ctx.event, ctx.ports);
}

async function refreshDirectImageOwnerEmbeddings(
  ctx: HandlerContext,
): Promise<void> {
  const refs = await collectDirectImageSearchOwnerRefs(ctx);
  return await publishEmbeddingRefreshes(ctx.db, refs, ctx.event, ctx.ports);
}

// Maps each embedding-refresh handler to its ref-only collector, so the bulk
// path (runMutationSideEffectsForEntities) can bypass the handler's own
// per-event dispatch and instead accumulate refs for one wave-wide dispatch.
const embeddingRefCollectorByHandler = new Map<
  MutationSideEffectHandler,
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
  [
    refreshPlantingEmbeddingsForIngredient,
    collectPlantingEmbeddingRefsForIngredient,
  ],
  [
    refreshPlantingEmbeddingsForLocation,
    collectPlantingEmbeddingRefsForLocation,
  ],
  [
    refreshGardenEntryEmbeddingsForLocation,
    collectGardenEntryEmbeddingRefsForLocation,
  ],
  [
    refreshGardenEntryEmbeddingsForPlanting,
    collectGardenEntryEmbeddingRefsForPlanting,
  ],
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
  [refreshDirectImageOwnerEmbeddings, collectDirectImageSearchOwnerRefs],
]);

async function enqueueLocationAiRefresh(ctx: HandlerContext): Promise<void> {
  if (ctx.event.entity.entity !== "location") return;
  if (ctx.event.source.startsWith("location-ai.")) return;
  // The analysis fingerprint includes the location name, so a rename would force
  // a cache miss and fire two Anthropic vision calls (description + inventory
  // detection) for no benefit. Only refresh when images actually changed.
  if (!ctx.event.locationImagesChanged) return;
  const locationId = ctx.event.entity.id;
  const requestedAt = new Date().toISOString();
  await ctx.ports.publishTasks(
    ctx.db,
    [
      { kind: "location-ai.description.refresh", requestedAt, locationId },
      { kind: "location-ai.inventory.refresh", requestedAt, locationId },
    ],
    { source: `${ctx.event.source}:${ctx.event.action}` },
  );
}

// These side effects are intentionally coarse. Cubby data changes are low-volume,
// and background tasks are idempotent: embeddings skip unchanged text by hash and
// AI analyses skip unchanged fingerprints. Prefer obvious coverage over fragile
// changed-field detection.
//
// Location valuation has no side effect: it is computed on read from inventory.
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
      // Rename fan-out: planting subtitles and garden-entry titles embed the
      // current location's name.
      refreshPlantingEmbeddingsForLocation,
      refreshGardenEntryEmbeddingsForLocation,
      enqueueLocationAiRefresh,
    ],
    onDelete: [],
  },
  ingredient: {
    onCreate: [refreshOwnEmbedding],
    // Rename fan-out: recipe embeddings and planting titles embed the
    // ingredient's name.
    onUpdate: [
      refreshOwnEmbedding,
      refreshRecipeEmbeddingsForIngredient,
      refreshPlantingEmbeddingsForIngredient,
    ],
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
  planting: {
    onCreate: [refreshOwnEmbedding],
    onUpdate: [refreshOwnEmbedding, refreshGardenEntryEmbeddingsForPlanting],
    onDelete: [],
  },
  gardenEntry: {
    onCreate: [refreshOwnEmbedding],
    onUpdate: [refreshOwnEmbedding],
    onDelete: [],
  },
  image: {
    onCreate: [refreshDirectImageOwnerEmbeddings],
    onUpdate: [refreshDirectImageOwnerEmbeddings],
    onDelete: [],
  },
} satisfies MutationSideEffectManifest;

const handlersFor = (
  event: MutationSideEffectEvent,
): MutationSideEffectHandler[] => {
  const manifest = mutationSideEffectManifest[event.entity.entity];
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
): Promise<void> {
  for (const handler of handlersFor(event)) {
    await handler({ db, event, ports });
  }
}

export interface RunMutationSideEffectsOptions {
  /**
   * `"skip"` when the caller already refreshed the projections inside its own
   * write transaction (the entity kernel does); the default refreshes them
   * synchronously first, so a non-kernel writer's document is current before
   * its response returns.
   */
  projection?: "refresh" | "skip";
}

export async function runMutationSideEffects(
  db: Database,
  event: MutationSideEffectEvent,
  ports: MutationSideEffectPorts = productionMutationSideEffectPorts,
  options: RunMutationSideEffectsOptions = {},
): Promise<void> {
  if (options.projection !== "skip") {
    await refreshProjectionsForEvent(db, event, ports);
  }
  await runManifestHandlers(db, event, ports);
}

export async function runMutationSideEffectsForEntities(
  db: Database,
  events: MutationSideEffectEvent[],
  ports: MutationSideEffectPorts = productionMutationSideEffectPorts,
  options: RunMutationSideEffectsOptions = {},
): Promise<void> {
  if (events.length === 0) return;
  if (options.projection !== "skip") {
    const refs = uniqBy(
      (
        await Promise.all(
          events.map((event) => collectProjectionRefs(db, event, ports)),
        )
      ).flat(),
      (ref) => `${ref.entityType}:${ref.entityId}`,
    );
    if (refs.length > 0) await ports.refreshSearchDocuments(db, refs);
  }
  // Embedding-refresh handlers all funnel into the same task kind, so their
  // refs are collected across the whole wave and published once instead of
  // once per entity.
  const waveEmbeddingRefs: SearchableEntityRef[] = [];
  for (const event of events) {
    for (const handler of handlersFor(event)) {
      const collector = embeddingRefCollectorByHandler.get(handler);
      if (collector) {
        waveEmbeddingRefs.push(...(await collector({ db, event, ports })));
        continue;
      }
      await handler({ db, event, ports });
    }
  }
  const firstEvent = events[0];
  if (waveEmbeddingRefs.length > 0 && firstEvent) {
    await publishEmbeddingRefreshes(db, waveEmbeddingRefs, firstEvent, ports);
  }
}

/**
 * One monomorphic ref builder per entity — each closure's `entity` is its own
 * string literal, so `{ entity: "product", id }` is checked directly against
 * `EntityRefFor<"product">` with no union to distribute over. A single
 * generic builder can't do this: constructing `MutationSideEffectEntityRef`
 * (branded via `EntityId`, itself a `z.infer` of a branded schema) for an
 * opaque generic `E` needs a cast, and the unsafe-identifier guard rejects
 * any assertion into a branded-schema-derived type. Same shape of workaround
 * as `PARSE_CANONICAL_SHORTCODE` in `shortcode.ts`; indexing this by a
 * generic `E extends MutationSideEffectEntity` (below) correlates the result
 * back to `EntityId<E>` the same way `shortcodeSchema` indexes
 * `SHORTCODE_SCHEMA`.
 */
type EntityRefBuilderMap = {
  [E in MutationSideEffectEntity]: (
    id: EntityId<E>,
  ) => MutationSideEffectEntityRef;
};

const ENTITY_REF_BUILDER: EntityRefBuilderMap = {
  product: (id) => ({ entity: "product", id }),
  location: (id) => ({ entity: "location", id }),
  ingredient: (id) => ({ entity: "ingredient", id }),
  recipe: (id) => ({ entity: "recipe", id }),
  cookbook: (id) => ({ entity: "cookbook", id }),
  inventory: (id) => ({ entity: "inventory", id }),
  meal: (id) => ({ entity: "meal", id }),
  project: (id) => ({ entity: "project", id }),
  task: (id) => ({ entity: "task", id }),
  vendor: (id) => ({ entity: "vendor", id }),
  purchase: (id) => ({ entity: "purchase", id }),
  financialAccount: (id) => ({ entity: "financialAccount", id }),
  financialTransaction: (id) => ({ entity: "financialTransaction", id }),
  expense: (id) => ({ entity: "expense", id }),
  wish: (id) => ({ entity: "wish", id }),
  planting: (id) => ({ entity: "planting", id }),
  gardenEntry: (id) => ({ entity: "gardenEntry", id }),
  image: (id) => ({ entity: "image", id }),
};

/**
 * Build one `MutationSideEffectEvent` per id, sharing an entity type, action,
 * and source — the shape every entity adapter's delete/update/create side
 * effect dispatch repeats per id before handing the batch to
 * `runMutationSideEffectsForEntities`.
 */
export const mutationEvents = <E extends MutationSideEffectEntity>(
  entity: E,
  action: MutationAction,
  ids: readonly EntityId<E>[],
  source: string,
): MutationSideEffectEvent[] =>
  ids.map((id) => ({
    action,
    entity: ENTITY_REF_BUILDER[entity](id),
    source,
  }));
