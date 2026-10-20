import type { BackgroundTaskInput } from "@cubby/schemas/background-tasks";
import type { EntityId, EntityRef, RunId } from "@cubby/schemas/identifiers";
import { type SearchableEntityRef } from "@cubby/schemas/search";

import type { Database, DrizzleTransaction } from "~/server/db";
import { captureDerivedRefresh } from "~/server/generic/derived-refresh/repo/capture";
import {
  type PublishOptions,
  publishInBackground,
} from "~/server/workflows/background-tasks/publish";

const mutationSideEffectEntities = [
  "product",
  "productCategory",
  "location",
  "ingredient",
  "recipe",
  "cookbook",
  "device",
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

/** Capture a root inside a caller-owned transaction; dependency expansion is background work. */
export async function captureMutationEvent(
  db: Database | DrizzleTransaction,
  event: MutationSideEffectEvent,
): Promise<void> {
  await captureDerivedRefresh(db, [
    { entityKind: event.entity.entity, entityId: event.entity.id },
  ]);
}

/**
 * Refresh known denormalized search projections after a relationship change.
 * The caller supplies the affected refs captured before the relationship is
 * removed, so no fake mutation event or domain-row update is needed.
 */
export async function refreshDerivedSearchRefs(
  db: Database,
  refs: SearchableEntityRef[],
  _source: string,
  _ports: MutationSideEffectPorts = productionMutationSideEffectPorts,
): Promise<void> {
  const unique = [
    ...new Map(
      refs.map((ref) => [`${ref.entityKind}:${ref.entityId}`, ref]),
    ).values(),
  ];
  if (unique.length === 0) return;
  await captureDerivedRefresh(db, unique);
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
  /** The authoritative repo already recorded this root in its transaction. */
  captured?: boolean;
}

export async function runMutationSideEffects(
  db: Database,
  event: MutationSideEffectEvent,
  ports: MutationSideEffectPorts = productionMutationSideEffectPorts,
  _options: RunMutationSideEffectsOptions = {},
): Promise<void> {
  await runMutationSideEffectsForEntities(db, [event], ports, _options);
}

/**
 * Capture roots only; derived refresh and connection admission run in the background.
 */
export async function runMutationSideEffectsForEntities(
  db: Database,
  events: MutationSideEffectEvent[],
  ports: MutationSideEffectPorts = productionMutationSideEffectPorts,
  options: RunMutationSideEffectsOptions = {},
): Promise<void> {
  const [firstEvent] = events;
  if (!firstEvent) return;
  if (!options.captured)
    await captureDerivedRefresh(
      db,
      events.map((event) => ({
        entityKind: event.entity.entity,
        entityId: event.entity.id,
      })),
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
  device: (id) => ({ entity: "device", id }),
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
