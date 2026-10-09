import type { BackgroundTaskInput } from "@cubby/schemas/background-tasks";
import type { EntityId, EntityRef, RunId } from "@cubby/schemas/identifiers";
import {
  isEmbeddableEntity,
  searchableEntities,
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
  findChildTaskEmbeddingRefs,
  findCommercialEmbeddingRefsForExpenses,
  findEmbeddingRefsForCategories,
  findEmbeddingRefsForPurchases,
  findEmbeddingRefsForVendors,
  findGardenEntryEmbeddingRefsForLocations,
  findGardenEntryEmbeddingRefsForPlantings,
  findInventoryEmbeddingRefsForLocations,
  findInventoryEmbeddingRefsForProducts,
  findMealEmbeddingRefsForRecipes,
  findPlantingEmbeddingRefsForLocations,
  findPlantingEmbeddingRefsForPlants,
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
  "productCategory",
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
  "plant",
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
  /** The mutation's actor run, when the caller has one; threaded onto the queued task so its handler can attribute AI usage to it instead of a fresh background run. */
  runId?: RunId;
};

type MutationAction = MutationSideEffectEvent["action"];

const mutationSideEffectEntitySet = new Set<string>(mutationSideEffectEntities);

export const isMutationSideEffectRef = (
  ref: EntityRef,
): ref is MutationSideEffectEntityRef =>
  mutationSideEffectEntitySet.has(ref.entity);

export interface MutationSideEffectPorts {
  /** Publish after commit; failures are reported, never surfaced as rollback. */
  readonly publishTasks: (
    db: Database,
    tasks: readonly BackgroundTaskInput[],
    options: PublishOptions,
  ) => Promise<void>;
}

const productionMutationSideEffectPorts: MutationSideEffectPorts = {
  publishTasks: publishInBackground,
};

/** The search documents that embed text from a batch of one entity's rows. */
type SearchDependent<E extends MutationSideEffectEntity> = (
  db: Database | DrizzleTransaction,
  ids: EntityId<E>[],
) => Promise<SearchableEntityRef[]>;

type SearchDependents = {
  [E in MutationSideEffectEntity]: Partial<
    Record<"created" | "updated", readonly SearchDependent<E>[]>
  >;
};

const findImageSearchOwnerRefs: SearchDependent<"image"> = async (db, ids) => {
  const refs: SearchableEntityRef[] = [];
  for (const id of ids)
    refs.push(...(await findDirectImageSearchOwnerRefs(db, id)));
  return refs;
};

/**
 * The one roster of search dependencies. Each entry names the other search
 * documents whose text embeds the changed entity, so the same declaration
 * drives the synchronous projection refresh and the post-commit embedding
 * wave. A searchable entity's own document is implicit on create and update.
 *
 * Triggers are deliberately coarse — any create or update, never changed-field
 * detection — and each dependency is an explicit query rather than one
 * inferred from relation edges: Cubby data is low-volume and refresh tasks
 * skip unchanged text by hash, so obvious coverage beats fragile precision.
 * Deletes have no entry: `cascadeRemoval` retires search artifacts inside
 * every delete transaction, including direct repo deletes that skip this path.
 */
const searchDependents: SearchDependents = {
  product: {
    created: [findInventoryEmbeddingRefsForProducts],
    updated: [
      findInventoryEmbeddingRefsForProducts,
      findTaskEmbeddingRefsForProducts,
      findWishEmbeddingRefsForProducts,
    ],
  },
  productCategory: { updated: [findEmbeddingRefsForCategories] },
  location: {
    updated: [
      findInventoryEmbeddingRefsForLocations,
      findPlantingEmbeddingRefsForLocations,
      findGardenEntryEmbeddingRefsForLocations,
    ],
  },
  ingredient: { updated: [findRecipeEmbeddingRefsForIngredients] },
  recipe: { updated: [findMealEmbeddingRefsForRecipes] },
  cookbook: {},
  inventory: {},
  meal: {},
  project: { updated: [findTrackerEmbeddingRefsForProjects] },
  task: { updated: [findChildTaskEmbeddingRefs] },
  vendor: { updated: [findEmbeddingRefsForVendors] },
  purchase: { updated: [(db, ids) => findEmbeddingRefsForPurchases(db, ids)] },
  financialAccount: { updated: [findTransactionEmbeddingRefsForAccounts] },
  financialTransaction: {},
  // Expense writes can resolve Purchase/Vendor rows implicitly.
  expense: {
    created: [findCommercialEmbeddingRefsForExpenses],
    updated: [findCommercialEmbeddingRefsForExpenses],
  },
  wish: {},
  plant: { updated: [findPlantingEmbeddingRefsForPlants] },
  planting: { updated: [findGardenEntryEmbeddingRefsForPlantings] },
  gardenEntry: {},
  image: {
    created: [findImageSearchOwnerRefs],
    updated: [findImageSearchOwnerRefs],
  },
};

const searchDependentsFor = <E extends MutationSideEffectEntity>(
  entity: E,
  action: "created" | "updated",
): readonly SearchDependent<E>[] => searchDependents[entity][action] ?? [];

const searchableEntitySet = new Set<string>(searchableEntities);
const isSearchable = (
  entity: MutationSideEffectEntity,
): entity is MutationSideEffectEntity & SearchableEntity =>
  searchableEntitySet.has(entity);

const uniqueRefs = (refs: SearchableEntityRef[]) =>
  uniqBy(refs, (ref) => `${ref.entityKind}:${ref.entityId}`);

/**
 * Every search document a wave of events changes: each entity's own
 * projection plus its declared dependents (a product rename rewrites its
 * inventory, task, and wish documents). Events are batched per entity and
 * action, so a bulk wave runs each dependency query once.
 */
async function collectSearchRefs(
  db: Database | DrizzleTransaction,
  events: readonly MutationSideEffectEvent[],
): Promise<SearchableEntityRef[]> {
  const batches = new Map<
    string,
    {
      entity: MutationSideEffectEntity;
      action: "created" | "updated";
      ids: EntityId<MutationSideEffectEntity>[];
    }
  >();
  for (const { action, entity } of events) {
    if (action === "deleted") continue;
    const key = `${entity.entity}:${action}`;
    const batch = batches.get(key) ?? {
      entity: entity.entity,
      action,
      ids: [],
    };
    batch.ids.push(entity.id);
    batches.set(key, batch);
  }
  const refs: SearchableEntityRef[] = [];
  for (const { entity, action, ids } of batches.values()) {
    if (isSearchable(entity))
      refs.push(...ids.map((entityId) => ({ entityKind: entity, entityId })));
    for (const collect of searchDependentsFor(entity, action))
      refs.push(...(await collect(db, ids)));
  }
  return uniqueRefs(refs);
}

/**
 * Refresh every projection one event changes, on `db`. The entity kernel
 * calls this inside the write transaction; other writers get it from
 * {@link runMutationSideEffects}. Either way a projection failure is a visible
 * error, not a swallowed log — the projection is a SQL view of the row being
 * written and has no reason to fail independently.
 */
export async function refreshProjectionsForEvent(
  db: Database | DrizzleTransaction,
  event: MutationSideEffectEvent,
): Promise<void> {
  const refs = await collectSearchRefs(db, [event]);
  if (refs.length > 0) await refreshSearchDocuments(db, refs);
}

async function publishEmbeddingRefreshes(
  db: Database,
  refs: SearchableEntityRef[],
  source: string,
  ports: MutationSideEffectPorts,
): Promise<void> {
  // Purchase/financialTransaction/expense are searchable but not embeddable
  // (see `entity-manifest.ts` `embeddableEntities`): never queue a vector
  // refresh for them, even though they can appear in a collected ref set.
  const embeddable = uniqueRefs(
    refs.filter((ref) => isEmbeddableEntity(ref.entityKind)),
  );
  if (embeddable.length === 0) return;
  const requestedAt = new Date().toISOString();
  await ports.publishTasks(
    db,
    embeddable.map((ref) => ({
      kind: "entity-embedding.refresh" as const,
      requestedAt,
      entityKind: ref.entityKind,
      entityId: ref.entityId,
    })),
    { source },
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
  const unique = uniqueRefs(refs);
  if (unique.length === 0) return;
  await refreshSearchDocuments(db, unique);
  await publishEmbeddingRefreshes(db, unique, source, ports);
}

/** Independent of search: Location vision analysis, gated on image changes. */
async function enqueueLocationAiRefresh(
  db: Database,
  event: MutationSideEffectEvent,
  ports: MutationSideEffectPorts,
): Promise<void> {
  if (event.action === "deleted" || event.entity.entity !== "location") return;
  if (event.source.startsWith("location-ai.")) return;
  // The analysis fingerprint includes the location name, so a rename would force
  // a cache miss and fire two Anthropic vision calls (description + inventory
  // detection) for no benefit. Only refresh when images actually changed. A
  // location created WITH photos passes this gate too, so it is not born with
  // a NULL aiDescription.
  if (!event.locationImagesChanged) return;
  const locationId = event.entity.id;
  const requestedAt = new Date().toISOString();
  await ports.publishTasks(
    db,
    [
      {
        kind: "location-ai.description.refresh",
        requestedAt,
        locationId,
        runId: event.runId,
      },
      {
        kind: "location-ai.inventory.refresh",
        requestedAt,
        locationId,
        runId: event.runId,
      },
    ],
    { source: `${event.source}:${event.action}` },
  );
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
  await runMutationSideEffectsForEntities(db, [event], ports, options);
}

/**
 * One wave of mutations: refresh the projections it changes (unless the
 * caller already did, in its transaction), then publish one deduplicated
 * embedding-refresh task list for the whole wave.
 */
export async function runMutationSideEffectsForEntities(
  db: Database,
  events: MutationSideEffectEvent[],
  ports: MutationSideEffectPorts = productionMutationSideEffectPorts,
  options: RunMutationSideEffectsOptions = {},
): Promise<void> {
  const [firstEvent] = events;
  if (!firstEvent) return;
  const refs = await collectSearchRefs(db, events);
  if (options.projection !== "skip" && refs.length > 0)
    await refreshSearchDocuments(db, refs);
  await publishEmbeddingRefreshes(
    db,
    refs,
    `${firstEvent.source}:${firstEvent.action}`,
    ports,
  );
  for (const event of events) await enqueueLocationAiRefresh(db, event, ports);
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
  productCategory: (id) => ({ entity: "productCategory", id }),
  location: (id) => ({ entity: "location", id }),
  ingredient: (id) => ({ entity: "ingredient", id }),
  plant: (id) => ({ entity: "plant", id }),
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

/** Refresh docs and semantic work after an analysis/correction changes text. */
export async function refreshDirectImageOwnerSearchDocuments(
  db: Database,
  imageId: string,
): Promise<void> {
  const refs = await findDirectImageSearchOwnerRefs(db, imageId);
  await refreshCapturedImageSearchOwnerRefs(
    db,
    refs,
    "image-processing.search-text",
  );
}

/** Refresh image owners captured before an attachment edge is removed. */
export async function refreshCapturedImageSearchOwnerRefs(
  db: Database,
  refs: SearchableEntityRef[],
  source: string,
): Promise<void> {
  await refreshDerivedSearchRefs(db, refs, source);
}
