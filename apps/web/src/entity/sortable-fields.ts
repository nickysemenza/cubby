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
 * tree for type checking (`git show 18f8bd430:docs/reports/local-check-performance.md`).
 */
export const generatedSortRoster = (
  entity: Entity,
): GeneratedSortRoster | undefined =>
  // SAFETY: `generatedEntitySort` is `satisfies Partial<Record<Entity, …>>`,
  // so indexing by any entity is either a roster or absent.
  (generatedEntitySort as Partial<Record<Entity, GeneratedSortRoster>>)[entity];

/**
 * Single source for an entity list's opening sort field: the generated
 * roster's own `default`, or "createdAt" for the rare entity that declares no
 * `model.sort` at all (shouldn't happen for a routed entity today, but keeps
 * this total). Both `entity-list-ssr.ts` and `useEntityListPresentation.tsx`
 * call this so the SSR preload and the mounted table can never open on
 * different sorts.
 */
export const defaultSortFor = (entity: Entity): string =>
  generatedSortRoster(entity)?.default ?? "createdAt";

/**
 * Direction `defaultSortFor`'s field opens in. Declared alongside the field
 * itself on `model.sort.direction` (default "desc", right for the date/amount
 * columns most lists open on) — `ledgerParty`/`financialAccount` declare
 * "asc" so their name roster opens A→Z instead of the table's blanket
 * descending default.
 */
export const defaultSortDirectionFor = (entity: Entity): "asc" | "desc" =>
  generatedSortRoster(entity)?.direction ?? "desc";

/** Mirrors `useEntityListPresentation`'s opening table-state sort. */
export function entityListDefaultSort(entity: Entity) {
  return {
    orderBy: defaultSortFor(entity),
    direction: defaultSortDirectionFor(entity),
  };
}
