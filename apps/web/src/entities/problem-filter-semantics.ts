/**
 * Server/compiler entrypoint for Problem filter semantics.
 *
 * Declarations live in `filter-search-fields.ts`, the dependency-light
 * semantic registry that also generates route search fields. Compilation
 * stays here so eager route validation does not pull the richer filter
 * runtime (including ts-pattern) into the application shell.
 */
import type { Entity } from "@cubby/schemas/entity";
import {
  entityFilterUrlKeys,
  problemFilterSemantics,
} from "./filter-search-fields";
import { buildFiltersFromManifest, type FilterSpecCore } from "./filters";
import type { FilterAssembly } from "./problem-query";

export const problemFilterSpecs = problemFilterSemantics;

/** Compile a Problem assembly through the server-safe semantic registry. */
export function compileProblemFilters(
  entity: Entity,
  assembly: FilterAssembly,
): Record<string, unknown> {
  const specs: readonly FilterSpecCore[] =
    (
      problemFilterSemantics as Partial<
        Record<Entity, readonly FilterSpecCore[]>
      >
    )[entity] ?? [];
  const values = new Map(assembly.map(({ id, value }) => [id, value]));
  const byColumn = new Map(specs.map((spec) => [spec.columnId, spec]));
  const unknown = assembly.find(({ id }) => !byColumn.has(id));
  if (unknown) {
    throw new Error(
      `No server-safe Problem filter semantic for ${entity}.${unknown.id}`,
    );
  }
  const urlKeys = new Set(entityFilterUrlKeys(entity));
  const nonSerializable = assembly.find(({ id }) => {
    const spec = byColumn.get(id);
    return !spec || !urlKeys.has(spec.urlKey ?? spec.columnId);
  });
  if (nonSerializable) {
    throw new Error(
      `Problem filter ${entity}.${nonSerializable.id} has no canonical URL semantic`,
    );
  }
  return buildFiltersFromManifest(specs, (columnId) => values.get(columnId));
}
