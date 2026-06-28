import type { BackgroundBatchRef } from "@cubby/schemas/background-jobs";
import type {
  IngredientId,
  LocationId,
  ProductId,
} from "@cubby/schemas/identifiers";
import {
  ingredientId,
  inventoryId,
  locationId,
  productId,
  recipeId,
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
  softDeleteEntityEmbeddings,
} from "~/server/repo/entity-embedding";

const mutationEntityRefSchema = z.discriminatedUnion("entityType", [
  z.object({ entityType: z.literal("product"), entityId: productId }),
  z.object({ entityType: z.literal("location"), entityId: locationId }),
  z.object({ entityType: z.literal("ingredient"), entityId: ingredientId }),
  z.object({ entityType: z.literal("recipe"), entityId: recipeId }),
  z.object({ entityType: z.literal("inventory"), entityId: inventoryId }),
  z.object({ entityType: z.literal("image"), entityId: z.uuid() }),
]);

export const mutationSideEffectEventSchema = z.object({
  action: z.enum(["created", "updated", "deleted"]),
  entity: mutationEntityRefSchema,
  source: z.string().min(1),
});

export type MutationSideEffectEvent = z.infer<
  typeof mutationSideEffectEventSchema
>;
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

async function refreshOwnEmbedding(
  ctx: HandlerContext,
): Promise<BackgroundBatchRef[]> {
  const ref = ownEmbeddingRef(ctx.event);
  if (!ref) return [];
  return await enqueueEntityEmbeddingRefreshMany(ctx.db, [ref], ctx.event);
}

async function softDeleteOwnEmbedding(
  ctx: HandlerContext,
): Promise<BackgroundBatchRef[]> {
  const ref = ownEmbeddingRef(ctx.event);
  if (!ref) return [];
  await softDeleteEntityEmbeddings(ctx.db, [ref]);
  return [];
}

async function refreshInventoryEmbeddingsForProduct(
  ctx: HandlerContext,
): Promise<BackgroundBatchRef[]> {
  if (ctx.event.entity.entityType !== "product") return [];
  const refs = await findInventoryEmbeddingRefsForProducts(ctx.db, [
    ctx.event.entity.entityId as ProductId,
  ]);
  return await enqueueEntityEmbeddingRefreshMany(ctx.db, refs, ctx.event);
}

async function refreshInventoryEmbeddingsForLocation(
  ctx: HandlerContext,
): Promise<BackgroundBatchRef[]> {
  if (ctx.event.entity.entityType !== "location") return [];
  const refs = await findInventoryEmbeddingRefsForLocations(ctx.db, [
    ctx.event.entity.entityId as LocationId,
  ]);
  return await enqueueEntityEmbeddingRefreshMany(ctx.db, refs, ctx.event);
}

async function refreshRecipeEmbeddingsForIngredient(
  ctx: HandlerContext,
): Promise<BackgroundBatchRef[]> {
  if (ctx.event.entity.entityType !== "ingredient") return [];
  const refs = await findRecipeEmbeddingRefsForIngredients(ctx.db, [
    ctx.event.entity.entityId as IngredientId,
  ]);
  return await enqueueEntityEmbeddingRefreshMany(ctx.db, refs, ctx.event);
}

async function enqueueLocationAiRefresh(
  ctx: HandlerContext,
): Promise<BackgroundBatchRef[]> {
  if (ctx.event.entity.entityType !== "location") return [];
  if (ctx.event.source.startsWith("location-ai.")) return [];
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

async function enqueueLocationValuationRefresh(
  ctx: HandlerContext,
): Promise<BackgroundBatchRef[]> {
  const dispatched = await dispatchLocationValuationRecompute(
    ctx.db,
    ctx.event.source,
    ctx.event.entity,
  );
  return [dispatched.batch];
}

// These side effects are intentionally coarse. Cubby data changes are low-volume,
// and background jobs are idempotent: embeddings skip unchanged text by hash, AI
// analyses skip unchanged fingerprints, and duplicate valuation jobs are acceptable
// at the current scale. Prefer obvious coverage over fragile changed-field detection.
export const mutationSideEffectManifest = {
  product: {
    onCreate: [refreshOwnEmbedding, refreshInventoryEmbeddingsForProduct],
    onUpdate: [
      refreshOwnEmbedding,
      refreshInventoryEmbeddingsForProduct,
      enqueueLocationValuationRefresh,
    ],
    onDelete: [softDeleteOwnEmbedding],
  },
  location: {
    onCreate: [refreshOwnEmbedding],
    onUpdate: [
      refreshOwnEmbedding,
      refreshInventoryEmbeddingsForLocation,
      enqueueLocationAiRefresh,
      enqueueLocationValuationRefresh,
    ],
    onDelete: [softDeleteOwnEmbedding, enqueueLocationValuationRefresh],
  },
  ingredient: {
    onCreate: [refreshOwnEmbedding],
    onUpdate: [refreshOwnEmbedding, refreshRecipeEmbeddingsForIngredient],
    onDelete: [softDeleteOwnEmbedding],
  },
  recipe: {
    onCreate: [refreshOwnEmbedding],
    onUpdate: [refreshOwnEmbedding],
    onDelete: [softDeleteOwnEmbedding],
  },
  inventory: {
    onCreate: [refreshOwnEmbedding, enqueueLocationValuationRefresh],
    onUpdate: [refreshOwnEmbedding, enqueueLocationValuationRefresh],
    onDelete: [softDeleteOwnEmbedding, enqueueLocationValuationRefresh],
  },
  image: {
    onCreate: [],
    onUpdate: [],
    onDelete: [],
  },
} satisfies MutationSideEffectManifest;

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

export async function runMutationSideEffects(
  db: Database,
  event: MutationSideEffectEvent,
): Promise<BackgroundBatchRef[]> {
  const parsed = mutationSideEffectEventSchema.parse(event);
  const handlers = handlersFor(parsed);
  const batches: BackgroundBatchRef[] = [];
  for (const handler of handlers) {
    batches.push(...(await handler({ db, event: parsed })));
  }
  return batches;
}

export async function runMutationSideEffectsForEntities(
  db: Database,
  events: MutationSideEffectEvent[],
): Promise<BackgroundBatchRef[]> {
  const batches: BackgroundBatchRef[] = [];
  for (const event of events) {
    batches.push(...(await runMutationSideEffects(db, event)));
  }
  return batches;
}
