import type {
  EditableEntity,
  EntityEditDefinition,
  EntityEditRecord,
} from "./types";

/** A complete registry has one definition for every standard editable entity. */
export type EntityEditRegistry = {
  readonly [E in EditableEntity]: EntityEditDefinition<E, EntityEditRecord>;
};

/**
 * Makes completeness a declaration-site error while keeping each definition's
 * implementation local to its entity module.
 */
export function defineEntityEditRegistry(
  registry: EntityEditRegistry,
): EntityEditRegistry {
  return registry;
}

export function getEntityEditDefinition<E extends EditableEntity>(
  registry: EntityEditRegistry,
  entity: E,
): EntityEditDefinition<E, EntityEditRecord> {
  return registry[entity];
}
