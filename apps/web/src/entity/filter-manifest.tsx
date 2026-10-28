import type { Entity } from "@cubby/schemas/entity";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { CURRENT_MEMBER_FILTER, humanize } from "@cubby/shared";
import type { QueryClient } from "@tanstack/react-query";
import { match } from "ts-pattern";

import { EntityIcon } from "~/entity/entities";
import { isPickerEntity, recordSource } from "~/entity/picker/picker";
import { resolveDateRange } from "~/lib/date-range-presets";
import type { PickerOption } from "~/ui/combobox/picker-option";
import { OptionGlyph } from "~/ui/common/option-glyph";
import {
  barFieldFromConfig,
  type FilterBarField,
  type FilterValueType,
} from "~/ui/data-table/filter-bar-core";
import type { FilterConfig } from "~/ui/data-table/table-meta";
import {
  deferredFilterOptionSource,
  deferredRosterControls,
  filterOptionItems,
  type RuntimeFilterOptions,
} from "~/ui/hooks/filter-option-types";

import * as behavior from "./filter-behavior";
import {
  editableFilterSpecs,
  type FilterSpecCore,
  type FilterPatch,
  isMultiFilterKind,
  nullableSentinelOptions,
} from "./filters";
import { entityMetadata, type EntityMetadataFor } from "./metadata";

export interface FilterSpec extends FilterSpecCore {
  unsupportedReason?: string;
  group?: string;
  placeholder: string;
  options?: PickerOption[];
  optionsKey?: string;
  label?: string;
}

type FilterDescriptor = EntityMetadataFor<Entity>["filterDescriptors"][number];

const expandRules = {
  dateRange: resolveDateRange,
  expenseCount: behavior.resolveExpenseCount,
  vendorPurchases: behavior.resolveVendorPurchases,
  latestPurchaseDate: behavior.resolveLatestPurchaseDate,
  verifiedDate: behavior.resolveVerifiedDate,
  productPurchaseDate: behavior.resolveProductPurchaseDateFilter,
  productTask: behavior.resolveProductTaskFilter,
  taskDue: behavior.resolveTaskDueFilter,
  postedDate: behavior.resolvePostedDate,
  createdDate: behavior.resolveCreatedDate,
  updatedDate: behavior.resolveUpdatedDate,
};

/** Adapt only the requested compiler slice. Exact wire semantics stay server-owned. */
export const getEntityFilters = (
  queryClient: QueryClient,
  entity: Entity,
): readonly FilterSpec[] => {
  const metadata = entityMetadata(queryClient, entity);
  return metadata.filterDescriptors.map(
    (descriptor: FilterDescriptor): FilterSpec => {
      const presets = new Map<string, FilterPatch>(
        (descriptor.options ?? []).flatMap((option) =>
          !("expand" in option) ? [] : [[option.value, option.expand] as const],
        ),
      );
      const wire = descriptor.wire;
      const brand = descriptor.brand;
      const dateRange =
        descriptor.kind === "range" &&
        wire.kind === "range" &&
        (descriptor.range === null
          ? wire.from.endsWith("From") && wire.to.endsWith("To")
          : descriptor.range.kind === "date");
      const spec: FilterSpec = {
        columnId: descriptor.columnId,
        kind: descriptor.kind,
        placeholder: descriptor.placeholder,
        ...(descriptor.field === null ? {} : { field: descriptor.field }),
        ...(descriptor.urlKey === descriptor.columnId
          ? {}
          : { urlKey: descriptor.urlKey }),
        ...(descriptor.options === null
          ? {}
          : {
              options: descriptor.options.map((option): PickerOption => ({
                value: option.value,
                label: option.label,
                ...("meta" in option ? { meta: option.meta } : {}),
                ...("color" in option ? { color: option.color } : {}),
                ...("role" in option ? { role: option.role } : {}),
                ...("glyph" in option && option.glyph
                  ? {
                      glyph: option.glyph,
                      icon: (
                        <OptionGlyph
                          name={option.glyph.phosphor}
                          className="size-3.5"
                        />
                      ),
                    }
                  : {}),
              })),
            }),
        ...(descriptor.optionsKey === null
          ? {}
          : { optionsKey: descriptor.optionsKey }),
        ...(descriptor.label === null ? {} : { label: descriptor.label }),
        ...(brand === null
          ? {}
          : {
              referenceEntity: brand.entity,
              ...("optionsKind" in brand && brand.optionsKind
                ? { referenceOptionsKind: brand.optionsKind }
                : {}),
              brand: (value: string) => parseShortcodeFor(brand.entity, value),
            }),
        ...(descriptor.expandRule === null
          ? {}
          : { expand: expandRules[descriptor.expandRule] }),
        ...(presets.size
          ? { expand: (value: string) => presets.get(value) ?? {} }
          : {}),
        ...(descriptor.kind === "range" &&
        wire.kind === "param" &&
        descriptor.expandRule === null &&
        !presets.size
          ? { expand: (value: string) => ({ [wire.name]: value }) }
          : {}),
        ...(descriptor.kind === "range" && wire.kind === "range"
          ? {
              range: {
                from: wire.from,
                to: wire.to,
                ...(dateRange
                  ? {}
                  : {
                      number: {
                        ...(descriptor.range?.nonnegative
                          ? { nonnegative: true }
                          : {}),
                        ...(descriptor.range?.int ? { int: true } : {}),
                        ...(descriptor.range?.describe
                          ? { describe: descriptor.range.describe }
                          : {}),
                      },
                    }),
              },
            }
          : {}),
        ...(descriptor.nullable === null
          ? {}
          : { nullable: descriptor.nullable }),
        ...(descriptor.match === null ? {} : { match: descriptor.match }),
        ...(descriptor.exclude === null ? {} : { exclude: descriptor.exclude }),
        ...(descriptor.subtree === null ? {} : { subtree: descriptor.subtree }),
        ...(descriptor.currentMember ? { currentMember: true } : {}),
        ...(descriptor.singleValue === null ? {} : { singleValue: true }),
        ...(descriptor.exclusiveGroup === null
          ? {}
          : { exclusiveGroup: descriptor.exclusiveGroup }),
        ...(descriptor.aliasOf === null ? {} : { aliasOf: descriptor.aliasOf }),
        ...(descriptor.sentinels === null
          ? {}
          : { sentinels: descriptor.sentinels }),
      };
      return { ...spec, group: filterGroup(spec, metadata.summary) };
    },
  );
};

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
 * id, or an `optionsKey` list this list's caller does not supply. Its Any
 * value / No value keys alone are nothing to pick a value from.
 */
const isFreeText = (
  spec: FilterSpec,
  runtimeOptions: RuntimeFilterOptions | undefined,
): boolean => {
  if (spec.kind !== "multiselect" || spec.options?.length) return false;
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

/** What a declared filter's values are — the panel's glyph and editor. */
export const filterValueType = (spec: FilterSpec): FilterValueType =>
  match(spec.kind)
    .with("text", () => "text" as const)
    .with("boolean", () => "boolean" as const)
    .with("presence", () => "presence" as const)
    .with("idMulti", () => "entity" as const)
    .with("range", () =>
      spec.range?.number ? ("number" as const) : ("date" as const),
    )
    .otherwise(() =>
      spec.referenceEntity ? ("entity" as const) : ("enum" as const),
    );

/**
 * The Filters panel section a declared filter sits in: the titled edit
 * section holding its field, else one named by what its values are.
 */
export const filterGroup = (
  spec: FilterSpec,
  summary?: EntityMetadataFor<Entity>["summary"],
): string => {
  const keys = [spec.columnId, spec.field].filter(Boolean);
  const section = summary?.edit.sections.find(
    (candidate) =>
      candidate.title !== null &&
      candidate.fields.some((key) => keys.includes(key)),
  );
  if (section?.title) return section.title;
  const type = filterValueType(spec);
  return type === "entity"
    ? "Relations"
    : type === "date" || type === "number"
      ? "Dates & numbers"
      : type === "boolean" || type === "presence"
        ? "Quality"
        : "Other";
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
  const reference = spec.referenceEntity;
  return {
    placeholder: spec.placeholder,
    ...(spec.label ? { label: spec.label } : {}),
    filterType: filterTypeForSpec(spec),
    kind: spec.kind,
    valueType: filterValueType(spec),
    ...(reference
      ? {
          referenceEntity: reference,
          icon: <EntityIcon entity={reference} className="size-3.5" />,
        }
      : {}),
    group: spec.group ?? filterGroup(spec),
    ...(isFreeText(spec, runtimeOptions) ? { freeText: true } : {}),
    ...(spec.exclusiveGroup ? { exclusiveGroup: spec.exclusiveGroup } : {}),
    options: resolveSpecOptions(spec, runtimeOptions),
    matchAll: spec.match === undefined ? undefined : true,
    exclude: spec.exclude === undefined ? undefined : true,
    subtree: subtreeControl(spec, specs),
    dateRange: spec.range && !spec.range.number ? true : undefined,
    numberRange: spec.range?.number,
    ...deferredRosterControls(deferred),
    // A static reference roster (a graph picklist) picks records too.
    records:
      deferred?.records ??
      (spec.referenceEntity && isPickerEntity(spec.referenceEntity)
        ? recordSource(spec.referenceEntity)
        : undefined),
  };
};

export function manifestFilterConfig(
  queryClient: QueryClient,
  entity: Entity,
  columnId: string,
  runtimeOptions?: RuntimeFilterOptions,
): FilterConfig | undefined {
  const specs = getEntityFilters(queryClient, entity);
  const spec = specs.find((candidate) => candidate.columnId === columnId);
  if (!spec) return undefined;
  return specFilterConfig(spec, specs, runtimeOptions);
}

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
    .filter(include)
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
