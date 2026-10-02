import type { Entity } from "@cubby/schemas/entity";
import { generatedEntitySort } from "@cubby/schemas/entity-sort";

type GeneratedSortRoster =
  (typeof generatedEntitySort)[keyof typeof generatedEntitySort];

/**
 * The generated `model.sort` roster for an entity, or `undefined` for the few
 * that declare none.
 *
 * A leaf module on purpose: server validation reads it, and importing it from
 * the browser registry (`entities.tsx`) tied every server module to the route
 * tree for type checking (docs/local-check-performance.md#typechecking).
 */
export const generatedSortRoster = (
  entity: Entity,
): GeneratedSortRoster | undefined =>
  // SAFETY: `generatedEntitySort` is `satisfies Partial<Record<Entity, …>>`,
  // so indexing by any entity is either a roster or absent.
  (generatedEntitySort as Partial<Record<Entity, GeneratedSortRoster>>)[entity];
