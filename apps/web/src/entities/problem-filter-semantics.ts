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

/**
 * The first declared range filter whose preset expands to an empty patch, or
 * undefined when every one resolves.
 *
 * A range spec expands a closed set of preset keys and returns an empty patch
 * for anything else. From a URL that leniency is deliberate — an unknown
 * `?date=` resolves to no bound rather than an error page. From a DECLARATION
 * it is a silent widening: the constraint vanishes and the view reports every
 * row. `unclassifiedExpenses` declared `cost` as the multiselect sentinel
 * `FILTER_NONE` where that expander accepts only `"none"`, and reported 7,450
 * rows against a true count of zero (#785).
 *
 * Exported because the same question has two askers with different reach.
 * {@link compileProblemFilters} asks it at runtime, but only for the Problem-
 * BACKED views it compiles; every other saved view goes straight to
 * `buildFiltersFromManifest`, where an empty patch is an `Object.assign` no-op
 * and the constraint disappears in silence. `view-manifest.unit.test.tsx` asks
 * it of the whole manifest so those are covered too — one predicate, not two.
 */
export function findUnexpandedRangeFilter(
  specs: readonly FilterSpecCore[],
  assembly: FilterAssembly,
): FilterAssembly[number] | undefined {
  const byColumn = new Map(specs.map((spec) => [spec.columnId, spec]));
  return assembly.find(({ id, value }) => {
    const spec = byColumn.get(id);
    if (spec?.kind !== "range") return false;
    const preset = Array.isArray(value) ? value[0] : value;
    if (preset === undefined) return false;
    const patch = spec.expand?.(preset);
    return !patch || Object.keys(patch).length === 0;
  });
}

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
  const unexpanded = findUnexpandedRangeFilter(specs, assembly);
  if (unexpanded) {
    throw new Error(
      `Problem filter ${entity}.${unexpanded.id} declares the range preset ` +
        `"${String(unexpanded.value)}", which expands to nothing — the filter ` +
        "would be dropped and the Problem would match every row.",
    );
  }
  return buildFiltersFromManifest(specs, (columnId) => values.get(columnId));
}
