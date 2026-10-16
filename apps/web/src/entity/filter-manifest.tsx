import type { Entity } from "@cubby/schemas/entity";
import { CURRENT_MEMBER_FILTER, humanize } from "@cubby/shared";

import type { PickerOption } from "~/ui/combobox/picker-option";
import {
  barFieldFromConfig,
  type FilterBarField,
} from "~/ui/data-table/filter-bar-core";
import type { FilterConfig } from "~/ui/data-table/table-meta";
import {
  deferredFilterOptionSource,
  filterOptionItems,
  type RuntimeFilterOptions,
} from "~/ui/hooks/filter-option-types";

import {
  type FilterKind,
  type FilterSpecCore,
  isMultiFilterKind,
  nullableSentinelOptions,
  partitionFilterSpecs,
} from "./filters";
import { generatedEntityFilters } from "./generated/entity-filter-bindings.gen";
import { entityFilterFieldMaps } from "./generated/entity-filter-fields.gen";

export interface FilterSpec extends FilterSpecCore {
  placeholder: string;
  options?: PickerOption[];
  optionsKey?: string;
  label?: string;
}

export { entityFilterFieldMaps };

export const getEntityFilters = (entity: Entity): readonly FilterSpec[] =>
  generatedEntityFilters[entity];

/** One deferred source per reference filter, even when two fields target the same entity. */
export const referenceFilterOptionsKey = (
  spec: Pick<FilterSpec, "columnId" | "referenceEntity">,
): string | undefined =>
  spec.referenceEntity
    ? `reference:${spec.referenceEntity}:${spec.columnId}`
    : undefined;

const filterTypeForKind = (
  kind: FilterKind,
): "text" | "select" | "multiselect" =>
  kind === "text" ? "text" : isMultiFilterKind(kind) ? "multiselect" : "select";

/** The "Include sub-…" toggle a reference filter's editor shows. */
const subtreeControl = (
  spec: FilterSpec,
  specs: readonly FilterSpec[],
): FilterConfig["subtree"] => {
  if (!spec.subtree || spec.urlOnly) return undefined;
  const toggle = specs.find((candidate) => candidate.columnId === spec.subtree);
  return {
    label: toggle?.label ?? humanize(spec.subtree),
  };
};

const resolveSpecOptions = (
  spec: FilterSpec,
  runtimeOptions?: RuntimeFilterOptions,
): PickerOption[] => {
  const optionsKey = spec.optionsKey ?? referenceFilterOptionsKey(spec);
  const resolved = optionsKey
    ? filterOptionItems(runtimeOptions?.[optionsKey])
    : (spec.options ?? []);
  // A filter declaring `currentMember` offers the signed-in member as `@me`.
  const me = spec.currentMember
    ? [{ value: CURRENT_MEMBER_FILTER, label: "Me", meta: true as const }]
    : [];
  return [
    ...(spec.nullable ? nullableSentinelOptions() : []),
    ...me,
    ...(spec.sentinels ?? []).map((sentinel) => ({
      ...sentinel,
      meta: true as const,
    })),
    ...resolved,
  ];
};

const specFilterConfig = (
  spec: FilterSpec,
  specs: readonly FilterSpec[],
  runtimeOptions?: RuntimeFilterOptions,
): FilterConfig => {
  const optionsKey = spec.optionsKey ?? referenceFilterOptionsKey(spec);
  const deferred = optionsKey
    ? deferredFilterOptionSource(runtimeOptions?.[optionsKey])
    : undefined;
  return {
    placeholder: spec.placeholder,
    filterType: filterTypeForKind(spec.kind),
    options: resolveSpecOptions(spec, runtimeOptions),
    matchAll: spec.match === undefined ? undefined : true,
    subtree: subtreeControl(spec, specs),
    onActivate: deferred?.onActivate,
    onSearchChange: deferred?.onSearchChange,
    isLoading: deferred?.isLoading,
  };
};

export function manifestFilterConfig(
  entity: Entity,
  columnId: string,
  runtimeOptions?: RuntimeFilterOptions,
): FilterConfig | undefined {
  const specs = getEntityFilters(entity);
  const spec = specs.find((candidate) => candidate.columnId === columnId);
  if (!spec || spec.urlOnly) return undefined;
  return specFilterConfig(spec, specs, runtimeOptions);
}

export function manifestFilterFields(
  specs: readonly FilterSpec[],
  runtimeOptions?: RuntimeFilterOptions,
): FilterBarField[] {
  const [columnSpecs] = partitionFilterSpecs(specs);
  return columnSpecs.map((spec) =>
    barFieldFromConfig(
      spec.columnId,
      spec.label ?? humanize(spec.columnId),
      specFilterConfig(spec, specs, runtimeOptions),
    ),
  );
}
