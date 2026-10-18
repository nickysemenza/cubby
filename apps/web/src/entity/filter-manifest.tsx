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
  editableFilterSpecs,
  type FilterSpecCore,
  isMultiFilterKind,
  nullableSentinelOptions,
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

/** A picklist kind with nothing to pick from. */
const hasNoRoster = (spec: FilterSpec): boolean =>
  !spec.options?.length && !spec.optionsKey && !spec.nullable;

/**
 * The runtime roster a spec reads: the caller's `optionsKey` list when it
 * supplied one, else the reference's deferred roster, which every list loads
 * (`useEntityList`) — so an embedded list's Account picker is never empty.
 */
const runtimeOptionsKey = (
  spec: FilterSpec,
  runtimeOptions: RuntimeFilterOptions | undefined,
): string | undefined =>
  spec.optionsKey && runtimeOptions?.[spec.optionsKey] !== undefined
    ? spec.optionsKey
    : (referenceFilterOptionsKey(spec) ?? spec.optionsKey);

/**
 * A multiselect with nothing to pick from takes typed values: an external
 * id, or an `optionsKey` list this list's caller does not supply.
 */
const isFreeText = (
  spec: FilterSpec,
  runtimeOptions: RuntimeFilterOptions | undefined,
): boolean => {
  if (spec.kind !== "multiselect" || spec.options?.length || spec.nullable)
    return false;
  const key = runtimeOptionsKey(spec, runtimeOptions);
  return key === undefined || runtimeOptions?.[key] === undefined;
};

/**
 * A range with neither presets nor date bounds that passes its value
 * through (planting `activeOn`) takes one typed value.
 */
const filterTypeForSpec = (
  spec: FilterSpec,
): "text" | "select" | "multiselect" =>
  spec.kind === "text" ||
  (spec.kind === "range" && hasNoRoster(spec) && !spec.range)
    ? "text"
    : isMultiFilterKind(spec.kind) && !spec.singleValue
      ? "multiselect"
      : "select";

/**
 * A spec's Filters-menu label: its declared `label`, else the noun its
 * placeholder names ("Filter by related expenses id..." → "Expenses"). A
 * presence filter reads as its predicate ("Has expenses") so it never
 * shares a label with the relation's picker.
 */
export const filterSpecLabel = (
  spec: Pick<FilterSpec, "label" | "placeholder" | "columnId" | "kind">,
): string => {
  if (spec.label) return spec.label;
  // "related … id" names the relation's records; a bare "external id" keeps
  // its "id".
  const related = /^(Filter|Search)( by)? related\b/iu.test(spec.placeholder);
  const noun = spec.placeholder
    .replace(/^(Filter|Search)( by)?( related)?\s*/iu, "")
    .replace(
      related ? /\s*(id|presence)?\.\.\.$/iu : /\s*(presence)?\.\.\.$/iu,
      "",
    )
    .trim();
  if (!noun) return humanize(spec.columnId);
  return spec.kind === "presence"
    ? `Has ${noun.toLowerCase()}`
    : noun.slice(0, 1).toUpperCase() + noun.slice(1);
};

/**
 * Options for a picklist kind that declares none. The label already names
 * the predicate ("Has expenses", "Open tasks"), so the values answer it.
 */
const fallbackOptions = (spec: FilterSpec): PickerOption[] =>
  spec.kind === "presence"
    ? [
        { value: "has", label: "Yes" },
        { value: "none", label: "No" },
      ]
    : spec.kind === "boolean"
      ? [
          { value: "true", label: "Yes" },
          { value: "false", label: "No" },
        ]
      : [];

/** The "Include sub-…" toggle a reference filter's editor shows. */
const subtreeControl = (
  spec: FilterSpec,
  specs: readonly FilterSpec[],
): FilterConfig["subtree"] => {
  if (!spec.subtree) return undefined;
  const toggle = specs.find((candidate) => candidate.columnId === spec.subtree);
  return {
    label: toggle?.label ?? humanize(spec.subtree),
  };
};

const resolveSpecOptions = (
  spec: FilterSpec,
  runtimeOptions?: RuntimeFilterOptions,
): PickerOption[] => {
  const optionsKey = runtimeOptionsKey(spec, runtimeOptions);
  const resolved = optionsKey
    ? filterOptionItems(runtimeOptions?.[optionsKey])
    : (spec.options ?? fallbackOptions(spec));
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
  const optionsKey = runtimeOptionsKey(spec, runtimeOptions);
  const deferred = optionsKey
    ? deferredFilterOptionSource(runtimeOptions?.[optionsKey])
    : undefined;
  return {
    placeholder: spec.placeholder,
    ...(spec.label ? { label: spec.label } : {}),
    filterType: filterTypeForSpec(spec),
    ...(isFreeText(spec, runtimeOptions) ? { freeText: true } : {}),
    ...(spec.exclusiveGroup ? { exclusiveGroup: spec.exclusiveGroup } : {}),
    options: resolveSpecOptions(spec, runtimeOptions),
    matchAll: spec.match === undefined ? undefined : true,
    exclude: spec.exclude && { reason: spec.exclude.reason },
    subtree: subtreeControl(spec, specs),
    dateRange: spec.range === undefined ? undefined : true,
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
  if (!spec) return undefined;
  return specFilterConfig(spec, specs, runtimeOptions);
}

/**
 * A range with no presets, no date bounds and no pass-through value has no
 * web encoding at all (image `uploadedAgeHours`, a number range that only
 * MCP and native send), so it has no menu field to offer.
 */
const isExpressible = (spec: FilterSpec): boolean =>
  spec.kind !== "range" ||
  spec.range !== undefined ||
  spec.expand !== undefined ||
  !hasNoRoster(spec);

/**
 * The specs a list's Filters menu offers beside its columns' own: every
 * declared filter no column hosts, except one whose key the list fixes or
 * hides, and a declared `aliasOf` (its value decodes into the filter it
 * aliases). Another spec writing a request field already offered stays out
 * too, unless it is the one holding a value, so a deep link keeps its chip.
 */
export const menuOnlyFilterSpecs = (
  specs: readonly FilterSpec[],
  {
    hostedIds,
    excludedKeys,
    activeIds,
  }: {
    hostedIds: ReadonlySet<string>;
    excludedKeys: ReadonlySet<string | undefined>;
    activeIds: ReadonlySet<string>;
  },
): FilterSpec[] => {
  const wire = (spec: FilterSpec) => spec.field ?? spec.columnId;
  const offered = new Set(
    specs.filter((spec) => hostedIds.has(spec.columnId)).map(wire),
  );
  const menu: FilterSpec[] = [];
  for (const spec of editableFilterSpecs(specs)) {
    if (
      spec.aliasOf !== undefined ||
      hostedIds.has(spec.columnId) ||
      excludedKeys.has(spec.columnId) ||
      excludedKeys.has(wire(spec)) ||
      (offered.has(wire(spec)) && !activeIds.has(spec.columnId))
    )
      continue;
    offered.add(wire(spec));
    menu.push(spec);
  }
  return menu;
};

/**
 * Filters-menu fields for an entity's specs. `include` narrows them — a
 * table passes the specs no column of its own hosts.
 */
export function manifestFilterFields(
  specs: readonly FilterSpec[],
  runtimeOptions?: RuntimeFilterOptions,
  include: (spec: FilterSpec) => boolean = () => true,
): FilterBarField[] {
  return editableFilterSpecs(specs)
    .filter((spec) => isExpressible(spec) && include(spec))
    .map((spec) => {
      const field = barFieldFromConfig(
        spec.columnId,
        filterSpecLabel(spec),
        specFilterConfig(spec, specs, runtimeOptions),
      );
      const peers = specs.filter(
        (peer) =>
          spec.exclusiveGroup !== undefined &&
          peer.exclusiveGroup === spec.exclusiveGroup &&
          peer.columnId !== spec.columnId,
      );
      return peers.length
        ? {
            ...field,
            description: `Replaces ${peers.map(filterSpecLabel).join(" or ")}.`,
          }
        : field;
    });
}
