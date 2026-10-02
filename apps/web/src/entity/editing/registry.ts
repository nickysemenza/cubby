import type {
  EditableEntity,
  EntityEditDefinition,
  EntityEditRecord,
} from "./types";

/** A complete registry has one definition for every standard editable entity. */
export type EntityEditRegistry = {
  readonly [E in EditableEntity]: EntityEditDefinition<E, EntityEditRecord>;
};

export function getEntityEditDefinition<E extends EditableEntity>(
  registry: EntityEditRegistry,
  entity: E,
): EntityEditDefinition<E, EntityEditRecord> {
  return registry[entity];
}
