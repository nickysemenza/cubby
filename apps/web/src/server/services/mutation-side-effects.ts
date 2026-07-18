import type { BackgroundBatchRef } from "@cubby/schemas/background-jobs";
import {
  ingredientId,
  inventoryId,
  locationId,
  productId,
  projectId,
  purchaseId,
  recipeId,
  taskId,
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
} from "~/server/background-queue";
import type { Database } from "~/server/db";
import {
  findInventoryEmbeddingRefsForLocations,
  findInventoryEmbeddingRefsForProducts,
  findRecipeEmbeddingRefsForIngredients,
  findTrackerEmbeddingRefsForProjects,
} from "~/server/repo/entity-embedding";

const mutationEntityRefSchema = z.discriminatedUnion("entityType", [
  z.object({ entityType: z.literal("product"), entityId: productId }),
  z.object({ entityType: z.literal("location"), entityId: locationId }),
  z.object({ entityType: z.literal("ingredient"), entityId: ingredientId }),
  z.object({ entityType: z.literal("recipe"), entityId: recipeId }),
  z.object({ entityType: z.literal("inventory"), entityId: inventoryId }),
  z.object({ entityType: z.literal("project"), entityId: projectId }),
  z.object({ entityType: z.literal("task"), entityId: taskId }),
  z.object({ entityType: z.literal("purchase"), entityId: purchaseId }),
  z.object({ entityType: z.literal("image"), entityId: z.uuid() }),
]);

export const mutationSideEffectEventSchema = z.object({
  action: z.enum(["created", "updated", "deleted"]),
  entity: mutationEntityRefSchema,
  source: z.string().min(1),
  // Gates the location AI refresh: vision analysis only re-runs when images
  // actually changed (see enqueueLocationAiRefresh). Absent ⇒ no AI refresh.
  locationImagesChanged: z.boolean().optional(),
});

type MutationSideEffectEvent = z.infer<typeof mutationSideEffectEventSchema>;
type MutationEntityType = MutationSideEffectEvent["entity"]["entityType"];
type MutationAction = MutationSideEffectEvent["action"];

interface HandlerContext {
  db: Database;
  event: MutationSideEffectEvent;
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

async function enqueueEntityEmbeddingRefreshMany(
  db: Database,
  refs: SearchableEntityRef[],
  event: MutationSideEffectEvent,
): Promise<BackgroundBatchRef[]> {
  const uniqueRefs = uniqBy(refs, (ref) => `${ref.entityType}:${ref.entityId}`);
  if (uniqueRefs.length === 0) return [];

  const dispatched = await dispatchBackgroundJobs(db, {
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
  return await findInventoryEmbeddingRefsForProducts(ctx.db, [
    ctx.event.entity.entityId,
  ]);
};

const collectInventoryEmbeddingRefsForLocation: EmbeddingRefCollector = async (
  ctx,
) => {
  if (ctx.event.entity.entityType !== "location") return [];
  return await findInventoryEmbeddingRefsForLocations(ctx.db, [
    ctx.event.entity.entityId,
  ]);
};

const collectRecipeEmbeddingRefsForIngredient: EmbeddingRefCollector = async (
  ctx,
) => {
  if (ctx.event.entity.entityType !== "ingredient") return [];
  return await findRecipeEmbeddingRefsForIngredients(ctx.db, [
    ctx.event.entity.entityId,
  ]);
};

const collectTrackerEmbeddingRefsForProject: EmbeddingRefCollector = async (
  ctx,
) => {
  if (ctx.event.entity.entityType !== "project") return [];
  return await findTrackerEmbeddingRefsForProjects(ctx.db, [
    ctx.event.entity.entityId,
  ]);
};

async function refreshOwnEmbedding(
  ctx: HandlerContext,
): Promise<BackgroundBatchRef[]> {
  const refs = await collectOwnEmbeddingRef(ctx);
  return await enqueueEntityEmbeddingRefreshMany(ctx.db, refs, ctx.event);
}

// NOTE: there is no onDelete embedding handler. Embedding soft-delete is
// cascaded at the repo delete layer (softDeleteEntityEmbeddingsTx inside each
// entity's deleteXxx transaction), so it covers ALL delete callers — including
// direct repo deletes that skip this side-effect pipeline (e.g.
// problems.service.deleteUnusedIngredients). Re-adding it here would be a
// redundant higher-layer duplicate.

async function refreshInventoryEmbeddingsForProduct(
  ctx: HandlerContext,
): Promise<BackgroundBatchRef[]> {
  const refs = await collectInventoryEmbeddingRefsForProduct(ctx);
  return await enqueueEntityEmbeddingRefreshMany(ctx.db, refs, ctx.event);
}

async function refreshInventoryEmbeddingsForLocation(
  ctx: HandlerContext,
): Promise<BackgroundBatchRef[]> {
  const refs = await collectInventoryEmbeddingRefsForLocation(ctx);
  return await enqueueEntityEmbeddingRefreshMany(ctx.db, refs, ctx.event);
}

async function refreshRecipeEmbeddingsForIngredient(
  ctx: HandlerContext,
): Promise<BackgroundBatchRef[]> {
  const refs = await collectRecipeEmbeddingRefsForIngredient(ctx);
  return await enqueueEntityEmbeddingRefreshMany(ctx.db, refs, ctx.event);
}

// Tasks/purchases embed their project's name, so a project update fans out.
async function refreshTrackerEmbeddingsForProject(
  ctx: HandlerContext,
): Promise<BackgroundBatchRef[]> {
  const refs = await collectTrackerEmbeddingRefsForProject(ctx);
  return await enqueueEntityEmbeddingRefreshMany(ctx.db, refs, ctx.event);
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
  [
    refreshInventoryEmbeddingsForLocation,
    collectInventoryEmbeddingRefsForLocation,
  ],
  [
    refreshRecipeEmbeddingsForIngredient,
    collectRecipeEmbeddingRefsForIngredient,
  ],
  [refreshTrackerEmbeddingsForProject, collectTrackerEmbeddingRefsForProject],
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
    const dispatched = await dispatchBackgroundJobs(ctx.db, {
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
    onUpdate: [refreshOwnEmbedding, refreshInventoryEmbeddingsForProduct],
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
    onUpdate: [refreshOwnEmbedding],
    onDelete: [],
  },
  inventory: {
    onCreate: [refreshOwnEmbedding],
    onUpdate: [refreshOwnEmbedding],
    onDelete: [],
  },
  project: {
    onCreate: [refreshOwnEmbedding],
    // Rename fan-out: task/purchase embeddings include the project name.
    onUpdate: [refreshOwnEmbedding, refreshTrackerEmbeddingsForProject],
    onDelete: [],
  },
  task: {
    onCreate: [refreshOwnEmbedding],
    onUpdate: [refreshOwnEmbedding],
    onDelete: [],
  },
  purchase: {
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
// price/details change, or a location is changed/removed. Matches the entity/action
// combos that previously each enqueued a valuation refresh.
function needsValuationRecompute(event: MutationSideEffectEvent): boolean {
  switch (event.entity.entityType) {
    case "inventory":
      return true;
    case "product":
      return event.action === "updated";
    case "location":
      return event.action === "updated" || event.action === "deleted";
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
): Promise<BackgroundBatchRef[]> {
  const handlers = handlersFor(event);
  const batches: BackgroundBatchRef[] = [];
  for (const handler of handlers) {
    batches.push(...(await handler({ db, event })));
  }
  return batches;
}

export async function runMutationSideEffects(
  db: Database,
  event: MutationSideEffectEvent,
): Promise<BackgroundBatchRef[]> {
  const parsed = mutationSideEffectEventSchema.parse(event);
  const batches = await runManifestHandlers(db, parsed);
  if (needsValuationRecompute(parsed)) {
    const dispatched = await dispatchLocationValuationRecompute(
      db,
      parsed.source,
    );
    batches.push(dispatched.batch);
  }
  return batches;
}

export async function runMutationSideEffectsForEntities(
  db: Database,
  events: MutationSideEffectEvent[],
): Promise<BackgroundBatchRef[]> {
  const parsed = events.map((event) =>
    mutationSideEffectEventSchema.parse(event),
  );
  const batches: BackgroundBatchRef[] = [];
  // Embedding-refresh handlers all funnel into the same job kind, so their
  // refs are collected across the whole wave and dispatched once below
  // instead of once per entity (was N transactions for N entities).
  const waveEmbeddingRefs: SearchableEntityRef[] = [];
  for (const event of parsed) {
    for (const handler of handlersFor(event)) {
      const collector = embeddingRefCollectorByHandler.get(handler);
      if (collector) {
        waveEmbeddingRefs.push(...(await collector({ db, event })));
        continue;
      }
      batches.push(...(await handler({ db, event })));
    }
  }
  const firstEvent = parsed[0];
  if (waveEmbeddingRefs.length > 0 && firstEvent) {
    batches.push(
      ...(await enqueueEntityEmbeddingRefreshMany(
        db,
        waveEmbeddingRefs,
        firstEvent,
      )),
    );
  }
  // Valuation is whole-tree, so a bulk wave needs exactly one recompute, not one
  // per entity (the previous per-entity fan-out ran N whole-tree recomputes).
  if (parsed.some(needsValuationRecompute)) {
    const dispatched = await dispatchLocationValuationRecompute(
      db,
      parsed[0]?.source ?? "mutation.bulk",
    );
    batches.push(dispatched.batch);
  }
  return batches;
}
