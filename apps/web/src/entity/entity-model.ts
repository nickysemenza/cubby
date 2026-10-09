import type { Entity } from "@cubby/schemas/entity";
import type { entityFieldModels } from "@cubby/schemas/entity-fields";
import type {
  entityInspectorMetadata,
  entityManifest,
} from "@cubby/schemas/entity-manifest";
import type { entitySummary } from "@cubby/schemas/entity-summary";
import { type ReactNode, use } from "react";

import {
  entityInspectorLoaders,
  entityModelLoaders,
} from "./generated/entity-model-loaders.gen";

/**
 * One entity's generated model — field model, summary (names plus
 * presentation) and manifest descriptor — exactly as its per-entity module
 * declares it (`@cubby/schemas/entity-models/<entity>`).
 *
 * Browser code never imports the all-entities aggregates
 * (`cubby/no-client-entity-aggregate`): a route's generated client module
 * (`./generated/clients/`) registers the models its page reads, and any other
 * surface loads one on demand. See docs/adr/0009-per-entity-client-manifests.md.
 */
export type EntityModelOf<E extends Entity> = {
  readonly entity: E;
  readonly fields: (typeof entityFieldModels)[E];
  readonly summary: (typeof entitySummary)[E];
  readonly manifest: (typeof entityManifest)[E];
};
export type EntityModel = EntityModelOf<Entity>;
export type EntityInspectorOf<E extends Entity> =
  (typeof entityInspectorMetadata)[E];

// The generated loaders and the aggregate types describe the same per-entity
// modules; this keeps the two in step at compile time.
type LoadedModel<E extends Entity> = Awaited<
  ReturnType<(typeof entityModelLoaders)[E]>
>;
const _loadersMatchModels: { [E in Entity]: LoadedModel<E> } extends {
  [E in Entity]: EntityModelOf<E>;
}
  ? true
  : never = true;
void _loadersMatchModels;

const loaded = new Map<Entity, EntityModel>();
const pending = new Map<Entity, Promise<EntityModel>>();

/** Called by the generated client modules as they evaluate. */
export function registerEntityModels(...models: readonly EntityModel[]) {
  for (const model of models) loaded.set(model.entity, model);
}

export const isEntityModelLoaded = (entity: Entity): boolean =>
  loaded.has(entity);

/**
 * A loaded entity's model, synchronously. The route's own entity is
 * registered before its page renders. A read of any other entity during
 * render suspends the nearest boundary until that model's module arrives
 * (regression: an enum option, filter spec or form for a second entity
 * crashed its page); outside render it throws, naming the entity.
 */
function entityModel<E extends Entity>(entity: E): EntityModelOf<E> {
  const model = loaded.get(entity) ?? suspendForModel(entity);
  // SAFETY: `registerEntityModels` and `loadEntityModel` key each model by
  // its own `entity`.
  return model as EntityModelOf<E>;
}

function suspendForModel(entity: Entity): EntityModel {
  const pendingModel = loadEntityModel(entity);
  try {
    // `use` is valid in any function called while a component renders. Its
    // suspension signal (and a failed module load) propagate untouched;
    // outside render there is no dispatcher and React throws a TypeError.
    // oxlint-disable-next-line react-hooks/rules-of-hooks -- `use` may be called conditionally from any function running during render; outside render it throws and is reported below.
    return use(pendingModel);
  } catch (error) {
    if (error instanceof TypeError)
      throw new Error(
        `The ${entity} entity model is not loaded. Read it during render, under EntityModelBoundary, or after await loadEntityModels(["${entity}"]).`,
        { cause: error },
      );
    throw error;
  }
}

/** Load one entity's model module (cached; resolves at once when registered). */
function loadEntityModel<E extends Entity>(
  entity: E,
): Promise<EntityModelOf<E>> {
  let promise = pending.get(entity);
  if (promise === undefined) {
    const ready = loaded.get(entity);
    const load: () => Promise<EntityModel> = entityModelLoaders[entity];
    promise =
      ready === undefined
        ? load().then((model) => {
            loaded.set(entity, model);
            return model;
          })
        : Promise.resolve(ready);
    pending.set(entity, promise);
  }
  // SAFETY: the cached promise resolves to the model the loader keyed by `entity`.
  return promise as Promise<EntityModelOf<E>>;
}

/** Load several entities' models, e.g. for a cross-entity overview. */
export const loadEntityModels = (entities: readonly Entity[]) =>
  Promise.all(entities.map((entity) => loadEntityModel(entity)));

/**
 * One entity's model in render: synchronous once loaded, otherwise suspends
 * the nearest boundary until its module arrives.
 */
export function useEntityModel<E extends Entity>(entity: E): EntityModelOf<E> {
  const model = loaded.get(entity);
  // SAFETY: as in `entityModel`.
  return model === undefined
    ? use(loadEntityModel(entity))
    : (model as EntityModelOf<E>);
}

/** Every listed entity's model in render, suspending until all are loaded. */
export function useEntityModels(entities: readonly Entity[]): void {
  // Start every missing load before suspending on any: each promise is cached
  // per entity, so a retried render reads the same ones.
  const missing = entities
    .filter((entity) => !loaded.has(entity))
    .map((entity) => loadEntityModel(entity));
  for (const promise of missing) use(promise);
}

/**
 * Renders `children` once every listed entity's model is loaded, suspending
 * the nearest boundary until then. Wraps a cross-entity surface (an edit
 * dialog, a preview, a relation table) whose subtree reads models synchronously.
 */
export function EntityModelBoundary({
  entities,
  children,
}: {
  entities: readonly Entity[];
  children: ReactNode;
}): ReactNode {
  useEntityModels(entities);
  return children;
}

const inspectors = new Map<Entity, EntityInspectorOf<Entity>>();
const pendingInspectors = new Map<Entity, Promise<EntityInspectorOf<Entity>>>();

/** One entity's inspector metadata (cached), for the schema surfaces only. */
export function loadEntityInspector<E extends Entity>(
  entity: E,
): Promise<EntityInspectorOf<E>> {
  let promise = pendingInspectors.get(entity);
  if (promise === undefined) {
    const load: () => Promise<EntityInspectorOf<Entity>> =
      entityInspectorLoaders[entity];
    promise = load().then((inspector) => {
      inspectors.set(entity, inspector);
      return inspector;
    });
    pendingInspectors.set(entity, promise);
  }
  // SAFETY: the cached promise resolves to the inspector keyed by `entity`.
  return promise as Promise<EntityInspectorOf<E>>;
}

/** Every listed entity's inspector in render, suspending until all are loaded. */
export function useEntityInspectors(entities: readonly Entity[]): void {
  const missing = entities
    .filter((entity) => !inspectors.has(entity))
    .map((entity) => loadEntityInspector(entity));
  for (const promise of missing) use(promise);
}

/** A loaded entity's inspector metadata (after `useEntityInspectors`). */
export function entityInspector<E extends Entity>(
  entity: E,
): EntityInspectorOf<E> {
  const inspector = inspectors.get(entity);
  if (inspector === undefined)
    throw new Error(
      `The ${entity} inspector is not loaded. Render under useEntityInspectors(["${entity}"]) first.`,
    );
  // SAFETY: `loadEntityInspector` keys each inspector by its own entity.
  return inspector as EntityInspectorOf<E>;
}

/** One loaded entity's field model. */
export const entityFieldModel = <E extends Entity>(entity: E) =>
  entityModel(entity).fields;
/** One loaded entity's summary: names plus the compiled presentation. */
export const entitySummaryOf = <E extends Entity>(entity: E) =>
  entityModel(entity).summary;
/** One loaded entity's manifest descriptor (relationships, images, lifecycle). */
export const entityDescriptorOf = <E extends Entity>(entity: E) =>
  entityModel(entity).manifest;
