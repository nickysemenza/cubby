/**
 * Declared filters compiled to SQL over any set of columns: an entity table
 * (`declaredFilterPredicates`) or a relation list's projected columns. One
 * module owns each kind's include predicate, Any value / No value, Match all,
 * and the generated Exclude ("is not") negation.
 */
import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";
import { entityManifest } from "@cubby/schemas/entity-manifest";
import { generatedEntityListFields } from "@cubby/schemas/entity-list-fields";
import { presenceFilter, type PresenceFilter } from "@cubby/schemas/pagination";
import {
  type AnyColumn,
  and,
  arrayContains,
  or,
  SQL,
  sql,
} from "drizzle-orm";
import { z } from "zod";

import {
  arrayOverlapOrPresence,
  eqAny,
  eqAnyOrPresence,
  flagCondition,
  formatSearchTerm,
  householdDayRangeConditions,
  matchesStringValues,
  presenceCondition,
  rangeConditions,
  shortcodeSetCondition,
  textArrayMatches,
} from "~/server/db/helpers";
import { SHORTCODE_TABLE } from "~/server/generated/shortcode-tables.gen";
import {
  type HierarchyEntity,
  hierarchyDescendantsSql,
} from "~/server/generic/list/repo/hierarchy";

import { type ListFilterValues, shortcodeIdsSql } from "./field-compiler";

export const matchAll = z
  .enum(["any", "all"])
  .optional()
  .transform((value) => value === "all");
export const optionalText = z.string().optional();
export const optionalNumber = z.number().optional();
export const optionalDate = z.string().optional();
export const optionalBoolean = z.boolean().optional();
export const rangeBound = z.union([z.string(), z.number()]).optional();
export const optionalTextList = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((value) => (value === undefined ? undefined : [value].flat()));

/** The descriptor facets a filter predicate reads, independent of the literal roster. */
export interface DeclaredFilterDescriptor {
  readonly columnId: string;
  readonly field: string | null;
  readonly kind: string;
  readonly stored: Readonly<{
    columns: readonly string[];
    array: boolean;
  }> | null;
  readonly anyOf:
    | readonly Readonly<{
        key: string;
        source: "field" | "derived";
      }>[]
    | null;
  readonly nullable: Readonly<{ field: string }> | null;
  readonly match: Readonly<{ field: string }> | null;
  readonly exclude: Readonly<{ field: string }> | null;
  readonly range: Readonly<{ kind: "number" | "date" }> | null;
  readonly derived: string | null;
  readonly wire:
    | Readonly<{ kind: "param"; name: string }>
    | Readonly<{ kind: "range"; from: string; to: string; presence?: string }>;
}

/**
 * A stored column resolved to its table column and declared storage facts.
 * `value` is what filters read: the column, or the effective value of a
 * field that declares `resolution.inherit`.
 */
export interface FilterColumn {
  readonly column: AnyColumn;
  readonly value: AnyColumn | SQL;
  readonly kind: string;
  readonly nullable: boolean;
  /** The entity a foreign-key column points at, for `id`/`idMulti` filters. */
  readonly reference: string | null;
}


/** `formatSearchTerm` over a stored column, a `text[]` column by element. */
export const textPredicate = (
  { value, kind }: FilterColumn,
  term: string,
): SQL | undefined =>
  kind === "text-array"
    ? textArrayMatches(value, term)
    : formatSearchTerm(value, term);

/**
 * A boolean filter over a boolean column is equality; over any other
 * (nullable) column it is presence: `true` is NOT NULL, `false` is NULL.
 */
export const booleanPredicate = (
  { column, value, kind }: FilterColumn,
  flag: boolean | undefined,
): SQL | undefined =>
  kind === "boolean"
    ? value instanceof SQL
      ? flag === undefined
        ? undefined
        : sql`${value} = ${flag}`
      : eqAny(column, flag)
    : presenceCondition(
        value,
        flag === undefined ? undefined : flag ? "has" : "none",
      );

const hierarchyEntities = new Set<string>(
  Object.entries(generatedEntityListFields).flatMap(([key, fields]) =>
    fields.hierarchy === null ? [] : [key],
  ),
);
export const isHierarchyEntity = (entity: string): entity is HierarchyEntity =>
  hierarchyEntities.has(entity);

/**
 * The ids of the requested public shortcodes of `target`, widened to their
 * descendants when `target` declares `model.hierarchy` and the filter's
 * generated "Include sub-…" toggle is not switched off.
 */
export const requestedIdsSql = (
  target: ShortcodeEntity,
  codes: readonly string[],
  includeDescendants: boolean,
): SQL => {
  const selected = shortcodeIdsSql(target, (shortcode) =>
    shortcodeSetCondition(shortcode, codes),
  );
  return includeDescendants && isHierarchyEntity(target)
    ? hierarchyDescendantsSql(target, selected)
    : selected;
};

/**
 * An id filter over a foreign-key column: the column is in the set of ids
 * whose public shortcode was requested, including descendants of a
 * hierarchical reference. The referenced table is aliased so a
 * self-reference (a location's parent) never collides with the outer row,
 * preserving the outer root-table column for both selection and count.
 */
export const referencePredicate = (
  label: string,
  { column: { name }, value: column, reference }: FilterColumn,
  codes: readonly string[] | undefined,
  includeDescendants: boolean,
  presence: PresenceFilter,
): SQL | undefined => {
  const target = Object.keys(SHORTCODE_TABLE).find(
    (key): key is ShortcodeEntity => key === reference,
  );
  if (!target)
    throw new Error(
      `${label} id filter over ${name} references ${String(reference)}, which has no shortcode table`,
    );
  // A reference to a soft-deleted record is no value, as the group key and
  // the related-path filters read it.
  const live = entityManifest[target].softDelete
    ? sql`${column} IN ${shortcodeIdsSql(target, () => sql`ref."deletedAt" IS NULL`)}`
    : sql`${column} IS NOT NULL`;
  return or(
    codes === undefined || codes.length === 0
      ? undefined
      : sql`${column} IN ${requestedIdsSql(target, codes, includeDescendants)}`,
    presence === undefined
      ? undefined
      : presence === "has"
        ? live
        : sql`(${column} IS NULL OR NOT ${live})`,
  );
};

/**
 * A text-array multiselect: overlap (any picked value) or containment (Match
 * all), ORed with the generated Any value / No value.
 */
export const arrayPredicate = (
  { value: column, nullable }: FilterColumn,
  values: readonly string[] | undefined,
  presence: PresenceFilter,
  all: boolean,
): SQL | undefined =>
  all && values !== undefined && values.length > 0
    ? or(
        column instanceof SQL
          ? sql`${column} @> ARRAY[${sql.join(
              values.map((value) => sql`${value}`),
              sql`, `,
            )}]::text[]`
          : arrayContains(column, [...values]),
        arrayOverlapOrPresence(column, undefined, presence, nullable),
      )
    : arrayOverlapOrPresence(column, values, presence, nullable);


/**
 * The request keys a descriptor's predicate reads: its value (a range its
 * bounds and presence) and its Any value / No value, Match all and Exclude
 * keys.
 */
export const descriptorValueKeys = (descriptor: DeclaredFilterDescriptor): string[] => [
  ...(descriptor.wire.kind === "range"
    ? [
        descriptor.wire.from,
        descriptor.wire.to,
        ...(descriptor.wire.presence ? [descriptor.wire.presence] : []),
      ]
    : [descriptor.wire.name]),
  ...(descriptor.nullable ? [descriptor.nullable.field] : []),
  ...(descriptor.match ? [descriptor.match.field] : []),
  ...(descriptor.exclude ? [descriptor.exclude.field] : []),
];


/**
 * "Is not": the rows the include predicate does not match. NULL counts as
 * not matching, so a row with no value stays (`IS NULL OR NOT IN`); pair it
 * with the presence filter to drop empty rows.
 */
export const excludedPredicate = (
  include: ReadonlyArray<SQL | undefined>,
): SQL | undefined => flagCondition(false, () => and(...include));


export const nonEmpty = <T>(list: readonly T[] | undefined) =>
  list === undefined || list.length === 0 ? undefined : list;

export const dateRange = (
  column: AnyColumn | SQL,
  from: string | undefined,
  to: string | undefined,
): Array<SQL | undefined> => [
  from === undefined ? undefined : sql`${column} >= ${from}`,
  to === undefined ? undefined : sql`${column} <= ${to}`,
];

/**
 * A range's bounds with its Any value / No value. No value ORs with the
 * bounds, as it does with any-of values ("older than 30 days, or never");
 * Any value beside bounds is the bounds alone, which already imply a value.
 */
export const rangeOrPresence = (
  bounds: SQL | undefined,
  presence: PresenceFilter,
  presenceSql: (presence: "has" | "none") => SQL | undefined,
): SQL | undefined =>
  presence === undefined
    ? bounds
    : bounds === undefined
      ? presenceSql(presence)
      : presence === "has"
        ? bounds
        : or(bounds, presenceSql("none"));

/**
 * A filtered list's declared filters: the descriptors, the column each
 * stored descriptor reads, and any predicates only an entity table has
 * (derived values, row sets, suggestions). `excluding` marks the request an
 * Exclude key builds, so those predicates can read excluded context.
 */
export interface DeclaredFilterSet {
  readonly label: string;
  readonly descriptors: readonly DeclaredFilterDescriptor[];
  readonly column: (
    descriptor: DeclaredFilterDescriptor,
    key: string,
  ) => FilterColumn;
  /** The "Include sub-…" toggle key of a filter, when its target nests. */
  readonly subtree?: (key: string) => string | undefined;
  readonly extra?: (
    values: ListFilterValues,
    excluding: boolean,
    membership: "certain" | "possible",
  ) => Array<SQL | undefined>;
}

/** A generated subtree toggle reads absent as on. */
const includesDescendants = (
  set: DeclaredFilterSet,
  key: string,
  values: ListFilterValues,
): boolean => {
  const toggle = set.subtree?.(key);
  return toggle === undefined
    ? false
    : optionalBoolean.parse(values[toggle]) !== false;
};

/** A stored descriptor's include predicate over its resolved column. */
const columnPredicate = (
  set: DeclaredFilterSet,
  descriptor: DeclaredFilterDescriptor,
  values: ListFilterValues,
): SQL | undefined => {
  const key = descriptor.field ?? descriptor.columnId;
  const [columnKey] = descriptor.stored?.columns ?? [];
  if (columnKey === undefined) return undefined;
  const first = set.column(descriptor, columnKey);
  const value = values[key];
  const presence = descriptor.nullable
    ? presenceFilter.parse(values[descriptor.nullable.field])
    : undefined;
  switch (descriptor.kind) {
    case "boolean":
      return booleanPredicate(first, optionalBoolean.parse(value));
    case "multiselect":
      return descriptor.stored?.array
        ? arrayPredicate(
            first,
            optionalTextList.parse(value),
            presence,
            descriptor.match !== null &&
              matchAll.parse(values[descriptor.match.field]),
          )
        : first.value instanceof SQL
          ? or(
              nonEmpty(optionalTextList.parse(value)) === undefined
                ? undefined
                : matchesStringValues(
                    first.value,
                    optionalTextList.parse(value),
                  ),
              presenceCondition(first.value, presence),
            )
          : eqAnyOrPresence(first.column, value, presence);
    case "presence":
      return presenceCondition(first.value, presenceFilter.parse(value));
    case "idMulti":
      return referencePredicate(
        set.label,
        first,
        optionalTextList.parse(value),
        includesDescendants(set, key, values),
        presence,
      );
    case "range": {
      if (descriptor.wire.kind !== "range")
        throw new Error(
          `${set.label}.${descriptor.columnId} is a stored range without range wire keys`,
        );
      const { from, to, presence: presenceKey } = descriptor.wire;
      const rangePresence =
        presenceKey === undefined
          ? undefined
          : presenceFilter.parse(values[presenceKey]);
      const dateBounds = () => {
        const [low, high] = [
          optionalDate.parse(values[from]),
          optionalDate.parse(values[to]),
        ];
        // A timestamp bounds whole household days; a date compares as is.
        return first.kind === "timestamp"
          ? householdDayRangeConditions(first.value, low, high)
          : dateRange(first.value, low, high);
      };
      const bounds =
        descriptor.range?.kind !== "date"
          ? rangeConditions(
              first.value,
              {
                [`${key}Min`]: optionalNumber.parse(values[from]),
                [`${key}Max`]: optionalNumber.parse(values[to]),
              },
              key,
            )
          : dateBounds();
      return rangeOrPresence(and(...bounds), rangePresence, (wanted) =>
        presenceCondition(first.value, wanted),
      );
    }
    default:
      throw new Error(
        `${set.label}.${descriptor.columnId} cannot derive a ${descriptor.kind} predicate`,
      );
  }
};

/**
 * One filter request per excluded value list: the descriptor's value key set
 * to the excluded values, beside its "Include sub-…" toggle, so the include
 * predicate it builds is the one to negate. Excluding a hierarchy node
 * therefore excludes its descendants unless the toggle is off.
 */
const excludedFilterRequests = (
  set: DeclaredFilterSet,
  values: ListFilterValues,
): ListFilterValues[] =>
  set.descriptors.flatMap((descriptor) => {
    if (descriptor.exclude === null) return [];
    const excluded = nonEmpty(
      optionalTextList.parse(values[descriptor.exclude.field]),
    );
    if (excluded === undefined) return [];
    const key = descriptor.field ?? descriptor.columnId;
    const toggle = set.subtree?.(key);
    return [
      {
        [key]: excluded,
        ...(descriptor.wire.kind === "param"
          ? { [descriptor.wire.name]: excluded }
          : {}),
        ...(toggle === undefined ? {} : { [toggle]: values[toggle] }),
      },
    ];
  });

/** Every declared filter's include predicate, then each Exclude's negation. */
export function compileDeclaredFilters(
  set: DeclaredFilterSet,
  values: ListFilterValues,
  membership: "certain" | "possible" = "certain",
): Array<SQL | undefined> {
  const include = (
    request: ListFilterValues,
    excluding: boolean,
  ): Array<SQL | undefined> => [
    ...(set.extra?.(request, excluding, excluding
      ? membership === "certain" ? "possible" : "certain"
      : membership) ?? []),
    ...set.descriptors
      .filter((descriptor) => descriptor.stored !== null)
      .map((descriptor) => columnPredicate(set, descriptor, request)),
  ];
  return [
    ...include(values, false),
    ...excludedFilterRequests(set, values).map((excluded) =>
      excludedPredicate(include(excluded, true)),
    ),
  ];
}

/** The subtree toggles an entity's generated list fields declare. */
export const entitySubtreeToggle =
  (entity: keyof typeof generatedEntityListFields) =>
  (key: string): string | undefined =>
    Object.entries(generatedEntityListFields[entity].subtree).find(
      ([filter]) => filter === key,
    )?.[1];
