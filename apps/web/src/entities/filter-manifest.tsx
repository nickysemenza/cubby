import type { Entity } from "@cubby/schemas/entity";
import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";

import type { FilterConfig } from "~/app/_components/data-table/columnHelpers";
import {
  barFieldFromConfig,
  type FilterBarField,
} from "~/app/_components/data-table/filter-bar-core";
import {
  deferredFilterOptionSource,
  filterOptionItems,
  type RuntimeFilterOptions,
} from "~/app/_components/hooks/filter-option-types";
import type { FilterableComboboxItem } from "~/components/ui/combobox";

import {
  type FilterKind,
  type FilterSpecCore,
  humanize,
  isMultiFilterKind,
  nullableSentinelOptions,
} from "./filters";
import { generatedEntityFilters } from "./generated/entity-filter-bindings.gen";
import { entityFilterFieldMaps } from "./generated/entity-filter-fields.gen";

export interface FilterSpec extends FilterSpecCore {
  placeholder: string;
  options?: FilterableComboboxItem[];
  optionsKey?: string;
  label?: string;
  /** Declared target for the shortcode-native reference, when applicable. */
  referenceEntity?: ShortcodeEntity;
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

const resolveSpecOptions = (
  spec: FilterSpec,
  runtimeOptions?: RuntimeFilterOptions,
): FilterableComboboxItem[] => {
  const optionsKey = spec.optionsKey ?? referenceFilterOptionsKey(spec);
  const resolved = optionsKey
    ? filterOptionItems(runtimeOptions?.[optionsKey])
    : (spec.options ?? []);
  return spec.nullable
    ? [...nullableSentinelOptions(spec.nullable.label), ...resolved]
    : resolved;
};

const specFilterConfig = (
  spec: FilterSpec,
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
  const spec = getEntityFilters(entity).find(
    (candidate) => candidate.columnId === columnId,
  );
  if (!spec || spec.urlOnly) return undefined;
  return specFilterConfig(spec, runtimeOptions);
}

export function manifestFilterFields(
  specs: readonly FilterSpec[],
  runtimeOptions?: RuntimeFilterOptions,
): FilterBarField[] {
  return specs
    .filter((spec) => !spec.urlOnly)
    .map((spec) =>
      barFieldFromConfig(
        spec.columnId,
        spec.label ?? humanize(spec.columnId),
        specFilterConfig(spec, runtimeOptions),
      ),
    );
}
