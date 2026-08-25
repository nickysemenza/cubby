import type { Entity } from "@cubby/schemas/entity";
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
}

export { entityFilterSearchFields } from "./filter-search-fields";
export { entityFilterFieldMaps };

export const getEntityFilters = (entity: Entity): readonly FilterSpec[] =>
  generatedEntityFilters[entity];

const filterTypeForKind = (
  kind: FilterKind,
): "text" | "select" | "multiselect" =>
  kind === "text" ? "text" : isMultiFilterKind(kind) ? "multiselect" : "select";

const resolveSpecOptions = (
  spec: FilterSpec,
  runtimeOptions?: RuntimeFilterOptions,
): FilterableComboboxItem[] => {
  const resolved = spec.optionsKey
    ? filterOptionItems(runtimeOptions?.[spec.optionsKey])
    : (spec.options ?? []);
  return spec.nullable
    ? [...nullableSentinelOptions(spec.nullable.label), ...resolved]
    : resolved;
};

const specFilterConfig = (
  spec: FilterSpec,
  runtimeOptions?: RuntimeFilterOptions,
): FilterConfig => {
  const deferred = spec.optionsKey
    ? deferredFilterOptionSource(runtimeOptions?.[spec.optionsKey])
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
