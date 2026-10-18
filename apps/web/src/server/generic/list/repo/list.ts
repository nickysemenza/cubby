import { suggestionStatus } from "@cubby/schemas/ai";
/**
 * The one list module every repository composes: the declared stored-filter
 * predicates (`declaredFilterPredicates`) and the per-entity list scaffold
 * (`listScaffold`) that binds them with the data-quality filters, audit
 * dates, lexical search, the generated sort roster and paging.
 */
import { scoredEntities, type ScoredEntity } from "@cubby/schemas/data-quality";
import type { Entity } from "@cubby/schemas/entity";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import { generatedEntityListFields } from "@cubby/schemas/entity-list-fields";
import {
  entityInspectorMetadata,
  entityManifest,
  type ShortcodeEntity,
} from "@cubby/schemas/entity-manifest";
import { generatedEntitySort } from "@cubby/schemas/entity-sort";
import { entitySummary } from "@cubby/schemas/entity-summary";
import { FILTER_NONE } from "@cubby/schemas/filter-sentinel-fields";
import {
  buildTakeSkip,
  type ListGroupSummary,
  type ListGroupBy,
  type ListNesting,
  listNestingSchema,
  type PaginationParams,
  presenceFilter,
  type PresenceFilter,
  type SortParams,
} from "@cubby/schemas/pagination";
import {
  searchableEntities,
  type SearchableEntity,
} from "@cubby/schemas/search";
import { parseShortcode } from "@cubby/shared";
import {
  type AnyColumn,
  and,
  arrayContains,
  asc,
  desc,
  getTableColumns,
  getTableName,
  inArray,
  type InferSelectModel,
  or,
  SQL,
  sql,
} from "drizzle-orm";
import type { PgSelect, PgTable } from "drizzle-orm/pg-core";
import { z } from "zod";

import type { Database, DrizzleTransaction } from "~/server/db";
import {
  effectiveFieldInSql,
  effectiveFieldSql,
  inheritedFieldOfColumn,
} from "~/server/db/computed/effective-field";
import {
  arrayOverlapOrPresence,
  auditDateWhereConditions,
  buildOrderBy,
  buildSearchConditions,
  countWhere,
  eqAny,
  eqAnyOrPresence,
  executeListQueryWithCount,
  flagCondition,
  formatSearchTerm,
  householdDayRangeConditions,
  type ListReadIntent,
  matchesStringValues,
  presenceCondition,
  rangeConditions,
  shortcodeSetCondition,
  textArrayMatches,
  unwrapDb,
} from "~/server/db/helpers";
import { createAppError } from "~/server/errors/app-error";
import { SHORTCODE_TABLE } from "~/server/generated/shortcode-tables.gen";
import type { QualityReadContext } from "~/server/generic/data-quality/repo/registry";
import {
  dataQualityFilterPredicates,
  qualityFilterContext,
  hasDataQualityFilter,
  qualityFilterSource,
  qualityFilterJoin,
  dataQualitySortResolver,
} from "~/server/generic/data-quality/repo/sql";
import { relatedWhereConditions } from "~/server/generic/entity-links/repo/related-view";
import {
  type HierarchyEntity,
  hierarchyDescendantsSql,
} from "~/server/generic/list/repo/hierarchy";
import type { ListProjection } from "~/server/generic/list/repo/list-contracts";
import { listTermExpanders } from "~/server/generic/list/repo/terms";
import {
  lexicalEligibility,
  lexicalRelevance,
} from "~/server/generic/search/repo/search-lexical";
import {
  traceListPageWithCount,
  withListReadTracing,
} from "~/server/observability/list-read-tracing";

import {
  type DerivedSqlArg,
  derivedFieldsOf,
  derivedOrderBy,
  derivedPredicateSql,
  derivedPrepare,
  derivedIntervalSql,
  derivedValueSet,
  derivedValueSql,
  type AnyDerivedSql,
  groupSql,
  type ListGroupSql,
  listFilterValues,
  type ListFilterValues,
  ListContext,
  type ListPrepare,
  relatedExistsSql,
  rowSetSql,
  shortcodeIdsSql,
} from "./field-compiler";
import { wantsListGroup } from "./list-projection";

const suggestionKinds = z
  .union([
    z.enum(["addition", "correction"]),
    z.array(z.enum(["addition", "correction"])),
  ])
  .optional()
  .transform((value) => (value === undefined ? [] : [value].flat()));
const matchAll = z
  .enum(["any", "all"])
  .optional()
  .transform((value) => value === "all");
const optionalText = z.string().optional();
const optionalNumber = z.number().optional();
const optionalDate = z.string().optional();
const optionalBoolean = z.boolean().optional();
const rangeBound = z.union([z.string(), z.number()]).optional();
const optionalTextList = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((value) => (value === undefined ? undefined : [value].flat()));

/** The descriptor facets this helper reads, independent of the literal roster. */
interface StoredDescriptorView {
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
  readonly exclude: Readonly<{ field: string; reason: string | null }> | null;
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
interface StoredColumn {
  readonly column: AnyColumn;
  readonly value: AnyColumn | SQL;
  readonly kind: string;
  readonly nullable: boolean;
  /** The entity a foreign-key column points at, for `id`/`idMulti` filters. */
  readonly reference: string | null;
}

const descriptorsFor = (entity: Entity): readonly StoredDescriptorView[] =>
  Object.entries(entityInspectorMetadata).find(([key]) => key === entity)?.[1]
    .filterDescriptors ?? [];
const fieldModelFor = (entity: Entity) =>
  Object.entries(entityFieldModels).find(([key]) => key === entity)?.[1];

const storedColumn = (
  entity: Entity,
  table: PgTable,
  descriptor: StoredDescriptorView,
  key: string,
): StoredColumn => {
  const storage = fieldModelFor(entity)?.storage ?? [];
  const columns: Record<string, AnyColumn> = getTableColumns(table);
  const stored = storage.find(({ key: k }) => k === key);
  const column =
    columns[key] ??
    Object.values(columns).find((c) => c.name === stored?.column);
  if (!column || !stored)
    throw new Error(
      `${entity}.${descriptor.columnId} has no table column ${key} for its stored filter`,
    );
  const inherited = inheritedFieldOfColumn(entity, stored.column);
  return {
    column,
    value:
      inherited === null
        ? column
        : effectiveFieldSql(entity, inherited, getTableName(table)),
    kind: stored.kind,
    nullable: stored.nullable,
    reference: stored.reference,
  };
};

/** `formatSearchTerm` over a stored column, a `text[]` column by element. */
const textPredicate = (
  { value, kind }: StoredColumn,
  term: string,
): SQL | undefined =>
  kind === "text-array"
    ? textArrayMatches(value, term)
    : formatSearchTerm(value, term);

/**
 * A boolean filter over a boolean column is equality; over any other
 * (nullable) column it is presence: `true` is NOT NULL, `false` is NULL.
 */
const booleanPredicate = (
  { column, value, kind }: StoredColumn,
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
const isHierarchyEntity = (entity: string): entity is HierarchyEntity =>
  hierarchyEntities.has(entity);

/**
 * The ids of the requested public shortcodes of `target`, widened to their
 * descendants when `target` declares `model.hierarchy` and the filter's
 * generated "Include sub-…" toggle is not switched off.
 */
const requestedIdsSql = (
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
const referencePredicate = (
  entity: Entity,
  { column: { name }, value: column, reference }: StoredColumn,
  codes: readonly string[] | undefined,
  includeDescendants: boolean,
  presence: PresenceFilter,
): SQL | undefined => {
  const target = Object.keys(SHORTCODE_TABLE).find(
    (key): key is ShortcodeEntity => key === reference,
  );
  if (!target)
    throw new Error(
      `${entity} id filter over ${name} references ${String(reference)}, which has no shortcode table`,
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
const arrayPredicate = (
  { value: column, nullable }: StoredColumn,
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

/** A generated subtree toggle reads absent as on. */
const subtreeToggle = (
  entity: Entity,
  key: string,
  values: ListFilterValues,
): boolean => {
  const toggle = Object.entries(generatedEntityListFields[entity].subtree).find(
    ([filter]) => filter === key,
  )?.[1];
  return toggle === undefined
    ? false
    : optionalBoolean.parse(values[toggle]) !== false;
};

/**
 * The request keys a descriptor's predicate reads: its value (a range its
 * bounds and presence) and its Any value / No value, Match all and Exclude
 * keys.
 */
const descriptorValueKeys = (descriptor: StoredDescriptorView): string[] => [
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
 * One filter request per excluded value list: the descriptor's value key set
 * to the excluded values, beside its "Include sub-…" toggle, so the include
 * predicate it builds is the one to negate. Excluding a hierarchy node
 * therefore excludes its descendants unless the toggle is off. A filter
 * whose declaration cannot exclude fails with the reason it derives, the
 * same text every client shows on its disabled "is not".
 */
const excludedFilterRequests = (
  entity: Entity,
  values: ListFilterValues,
): ListFilterValues[] =>
  descriptorsFor(entity).flatMap((descriptor) => {
    if (descriptor.exclude === null) return [];
    const excluded = nonEmpty(
      optionalTextList.parse(values[descriptor.exclude.field]),
    );
    if (excluded === undefined) return [];
    if (descriptor.exclude.reason !== null)
      throw createAppError(
        "LIST_FILTER_EXCLUDE_UNSUPPORTED",
        `Cannot exclude ${entity} by "${descriptor.columnId}": ${descriptor.exclude.reason}`,
      );
    const key = descriptor.field ?? descriptor.columnId;
    const toggle = Object.entries(
      generatedEntityListFields[entity].subtree,
    ).find(([filter]) => filter === key)?.[1];
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

/**
 * "Is not": the rows the include predicate does not match. NULL counts as
 * not matching, so a row with no value stays (`IS NULL OR NOT IN`); pair it
 * with the presence filter to drop empty rows.
 */
const excludedPredicate = (
  include: ReadonlyArray<SQL | undefined>,
): SQL | undefined => flagCondition(false, () => and(...include));

/** A condition over a derived value, given the value's SQL. */
type ValueTest = (
  condition: (value: SQL) => SQL | undefined,
) => SQL | undefined;

/**
 * Any value / No value over a derived value: a boolean reads true as a value
 * (an UNKNOWN as none), any other type reads NULL as no value.
 */
const valuePresence = (
  type: string,
  test: ValueTest,
  presence: PresenceFilter,
): SQL | undefined => {
  if (presence === undefined) return undefined;
  const has = test((value) =>
    type === "boolean"
      ? sql`COALESCE((${value}), false)`
      : sql`(${value}) IS NOT NULL`,
  );
  return has === undefined || presence === "has" ? has : sql`NOT ${has}`;
};

/**
 * The value a declared predicate receives, parsed by its descriptor's kind,
 * or undefined when the request does not set it.
 */
const predicateValue = (
  descriptor: StoredDescriptorView,
  values: ListFilterValues,
  value: unknown,
  presence: PresenceFilter,
) => {
  switch (descriptor.kind) {
    case "boolean":
      return optionalBoolean.parse(value);
    case "text":
      return optionalText.parse(value)?.trim() || undefined;
    case "presence":
      return presenceFilter.parse(value);
    case "range": {
      const wire = descriptor.wire;
      const range =
        wire.kind === "range"
          ? {
              from: rangeBound.parse(values[wire.from]),
              to: rangeBound.parse(values[wire.to]),
              presence: wire.presence
                ? presenceFilter.parse(values[wire.presence])
                : undefined,
              param: undefined,
            }
          : {
              from: undefined,
              to: undefined,
              presence: undefined,
              param: rangeBound.parse(value),
            };
      return Object.values(range).every((part) => part === undefined)
        ? undefined
        : range;
    }
    default: {
      const picked = nonEmpty(optionalTextList.parse(value));
      return picked === undefined && presence === undefined
        ? undefined
        : { values: picked ?? [], presence };
    }
  }
};

/** Derived SQL and prepared request data a scaffold passes to its filters. */
interface DerivedFilterInput {
  readonly derived: AnyDerivedSql;
  readonly context: ListContext;
}

/**
 * A condition over a `model.derived` value: a set value tests its relation
 * once per condition; any other value tests its per-row scalar.
 */
const derivedValueTest =
  (
    entity: Entity,
    table: PgTable & { id: AnyColumn },
    key: string,
    input: DerivedFilterInput | undefined,
  ): ValueTest =>
  (condition) => {
    const derived = input?.derived ?? {};
    const set = derivedValueSet(derived, key);
    if (set === null)
      return condition(
        derivedValueSql(
          entity,
          derived,
          key,
          input?.context ?? ListContext.empty,
        ),
      );
    const matched = condition(sql`value_set."value"`);
    return matched === undefined
      ? undefined
      : sql`${table.id} IN (SELECT value_set."id" FROM (${set}) value_set WHERE ${matched})`;
  };

/**
 * A text term against a `model.derived` entry: a `via` path matches when any
 * related record's field (or title) does, a value when it contains the term.
 */
const derivedTextMatch = (
  entity: Entity,
  table: PgTable & { id: AnyColumn },
  key: string,
  term: string,
  input: DerivedFilterInput | undefined,
): SQL | undefined => {
  const field = derivedFieldsOf(entity)[key];
  if (field?.shape === "via")
    return relatedExistsSql(entity, field, table.id, (_leaf, column) =>
      formatSearchTerm(column, term),
    );
  if (field?.shape === "value")
    return derivedValueTest(
      entity,
      table,
      key,
      input,
    )((column) => formatSearchTerm(column, term));
  throw new Error(`${entity}.model.derived.${key} cannot match text`);
};

/**
 * A text filter declared `anyOf`: each term matches when any member field
 * does, and several terms OR (an agent guessing at synonyms).
 */
const anyOfPredicate = (
  entity: Entity,
  table: PgTable & { id: AnyColumn },
  descriptor: StoredDescriptorView,
  members: NonNullable<StoredDescriptorView["anyOf"]>,
  values: ListFilterValues,
  input: DerivedFilterInput | undefined,
): SQL | undefined =>
  or(
    ...(
      optionalTextList.parse(values[descriptor.field ?? descriptor.columnId]) ??
      []
    )
      .map((term) => term.trim())
      .filter((term) => term !== "")
      .map((term) =>
        or(
          ...members.map(({ key, source }) =>
            source === "field"
              ? textPredicate(
                  storedColumn(entity, table, descriptor, key),
                  term,
                )
              : derivedTextMatch(entity, table, key, term, input),
          ),
        ),
      ),
  );

/**
 * The predicate of a filter descriptor declared `derived`: a related path
 * compiles to `EXISTS` (any cardinality), a repository value through its
 * SQL, and a declared predicate through the repository's function.
 */
const derivedFilterPredicates = (
  entity: Entity,
  table: PgTable & { id: AnyColumn },
  descriptor: StoredDescriptorView & { derived: string },
  values: ListFilterValues,
  input: DerivedFilterInput | undefined,
): Array<SQL | undefined> => {
  const key = descriptor.field ?? descriptor.columnId;
  const derivedKey = descriptor.derived;
  const field = derivedFieldsOf(entity)[derivedKey];
  if (field === undefined)
    throw new Error(
      `${entity}.${descriptor.columnId} is derived but declares no model.derived.${derivedKey} entry`,
    );
  const value =
    values[descriptor.wire.kind === "param" ? descriptor.wire.name : key];
  const context = input?.context ?? ListContext.empty;
  const derived = input?.derived ?? {};
  const presence = descriptor.nullable
    ? presenceFilter.parse(values[descriptor.nullable.field])
    : undefined;
  if (field.shape === "predicate") {
    const parsed = predicateValue(descriptor, values, value, presence);
    if (parsed === undefined) return [];
    return [
      derivedPredicateSql(
        entity,
        derived,
        derivedKey,
        context,
        descriptor.kind === "idMulti" && typeof parsed === "object"
          ? {
              ...parsed,
              includeDescendants: subtreeToggle(entity, key, values),
            }
          : parsed,
      ),
    ];
  }
  if (field.shape === "value") {
    const test = derivedValueTest(entity, table, derivedKey, input);
    switch (descriptor.kind) {
      case "text": {
        const term = optionalText.parse(value)?.trim();
        return term
          ? [derivedTextMatch(entity, table, derivedKey, term, input)]
          : [];
      }
      case "boolean":
        // An UNKNOWN value counts as not met, as `flagCondition` reads it.
        return [
          flagCondition(
            optionalBoolean.parse(value),
            () =>
              test((column) => sql`COALESCE((${column}), false)`) ?? sql`false`,
          ),
        ];
      case "presence":
        return [valuePresence(field.type, test, presenceFilter.parse(value))];
      case "range": {
        if (field.type === "dateInterval")
          return [
            intervalPredicate(
              entity,
              derived,
              derivedKey,
              context,
              descriptor,
              values,
            ),
          ];
        if (descriptor.wire.kind !== "range")
          throw new Error(
            `${entity}.${descriptor.columnId} is a range filter without range wire keys`,
          );
        const { from, to } = descriptor.wire;
        const bound = field.type === "date" ? optionalDate : optionalNumber;
        const [low, high] = [
          bound.parse(values[from]),
          bound.parse(values[to]),
        ];
        return [
          rangeOrPresence(
            // Unbounded reads no value, so an unrequested prepare stays unread.
            low === undefined && high === undefined
              ? undefined
              : test((column) =>
                  and(
                    low === undefined ? undefined : sql`${column} >= ${low}`,
                    high === undefined ? undefined : sql`${column} <= ${high}`,
                  ),
                ),
            descriptor.wire.presence === undefined
              ? undefined
              : presenceFilter.parse(values[descriptor.wire.presence]),
            (presence) => valuePresence(field.type, test, presence),
          ),
        ];
      }
      default: {
        const list = optionalTextList.parse(value);
        return [
          or(
            list === undefined || list.length === 0
              ? undefined
              : test(
                  (column) =>
                    sql`${column} IN (${sql.join(
                      list.map((item) => sql`${item}`),
                      sql`, `,
                    )})`,
                ),
            valuePresence(field.type, test, presence),
          ),
        ];
      }
    }
  }
  if (field.shape === "rows")
    throw new Error(
      `${entity}.${descriptor.columnId} goes through row set ${field.rows}, which compiles as one group`,
    );
  /** Whether a related row (with a value, for a field terminal) exists. */
  const relatedPresence = (presence: PresenceFilter): SQL | undefined => {
    if (presence === undefined) return undefined;
    const exists = relatedExistsSql(entity, field, table.id, (_leaf, column) =>
      field.terminal.kind === "field" ? sql`${column} IS NOT NULL` : sql`true`,
    );
    return presence === "has" ? exists : sql`NOT ${exists}`;
  };
  const all =
    descriptor.match !== null && matchAll.parse(values[descriptor.match.field]);
  /**
   * Any-of is one `EXISTS` over the picked values; Match all is one per
   * value. Either is ORed with the generated Any value / No value.
   */
  const anyOrAll = (
    picked: readonly string[] | undefined,
    matches: (leaf: SQL, column: SQL, items: readonly string[]) => SQL,
  ): SQL | undefined =>
    or(
      picked === undefined || picked.length === 0
        ? undefined
        : all
          ? and(
              ...picked.map((item) =>
                relatedExistsSql(entity, field, table.id, (leaf, column) =>
                  matches(leaf, column, [item]),
                ),
              ),
            )
          : relatedExistsSql(entity, field, table.id, (leaf, column) =>
              matches(leaf, column, picked),
            ),
      relatedPresence(presence),
    );
  switch (descriptor.kind) {
    case "idMulti": {
      const codes = optionalTextList.parse(value);
      const target = Object.keys(SHORTCODE_TABLE).find(
        (entry): entry is ShortcodeEntity => entry === field.target,
      );
      if (!target)
        throw new Error(
          `${entity}.${key} targets ${field.target}, which has no shortcode`,
        );
      const toggle = subtreeToggle(entity, key, values);
      return [
        anyOrAll(
          codes,
          (leaf, _column, items) =>
            sql`${leaf}."id" IN ${requestedIdsSql(target, items, toggle)}`,
        ),
      ];
    }
    case "presence":
      return [relatedPresence(presenceFilter.parse(value))];
    case "text": {
      const term = optionalText.parse(value)?.trim();
      return term
        ? [derivedTextMatch(entity, table, derivedKey, term, input)]
        : [];
    }
    case "boolean": {
      const flag = optionalBoolean.parse(value);
      if (flag === undefined) return [];
      return [
        relatedExistsSql(
          entity,
          field,
          table.id,
          (_leaf, column) => sql`${column} = ${flag}`,
        ),
      ];
    }
    default: {
      // An inherited terminal resolves its matching records once (the set
      // form) rather than walking ancestors per row.
      const inherited =
        field.terminal.kind === "field"
          ? inheritedFieldOfColumn(field.target, field.terminal.column)
          : null;
      return [
        anyOrAll(optionalTextList.parse(value), (leaf, column, items) => {
          const list = sql.join(
            items.map((item) => sql`${item}`),
            sql`, `,
          );
          return (
            (inherited === null
              ? null
              : effectiveFieldInSql(
                  field.target,
                  inherited,
                  sql`${leaf}."id"`,
                  list,
                )) ?? sql`${column} IN (${list})`
          );
        }),
      ];
    }
  }
};

/**
 * One filter's conditions on a row of its row set: `any` for its picked
 * values and Any value / No value together, or under Match all one
 * condition per picked value beside its presence. `absent` is true when the
 * filter also admits a record with no row (it asked for No value).
 */
interface RowCondition {
  readonly any: SQL | undefined;
  readonly all: readonly SQL[] | null;
  readonly presence: SQL | undefined;
  readonly absent: boolean;
}

/**
 * The filters through one declared row set (`model.rows`), compiled as one
 * group: every include condition holds on the same row, in one `EXISTS`.
 * No value also matches a record with no row at all when every condition
 * in the group admits absence, so "source is Plaid and no external id"
 * needs a Plaid alias. Match all gives each picked value its own `EXISTS`,
 * each carrying the sibling conditions. Exclude reaches here as a request
 * holding only the excluded values, so its negation is independent of the
 * group.
 */
const rowSetPredicates = (
  entity: Entity,
  table: PgTable,
  rows: string,
  descriptors: readonly (StoredDescriptorView & { derived: string })[],
  values: ListFilterValues,
): SQL | undefined => {
  const set = rowSetSql(entity, rows, getTableName(table));
  const conditions = descriptors.flatMap((descriptor): RowCondition[] => {
    const field = derivedFieldsOf(entity)[descriptor.derived];
    if (field?.shape !== "rows") return [];
    const key = descriptor.field ?? descriptor.columnId;
    const value =
      values[descriptor.wire.kind === "param" ? descriptor.wire.name : key];
    const column = set.column(field);
    const terminal = field.terminal;
    const target =
      terminal.kind === "record"
        ? Object.keys(SHORTCODE_TABLE).find(
            (entry): entry is ShortcodeEntity => entry === terminal.target,
          )
        : undefined;
    if (terminal.kind === "record" && target === undefined)
      throw new Error(
        `${entity}.${field.path} targets an entity without shortcodes`,
      );
    // A reference to a soft-deleted record counts as no value.
    const live =
      target === undefined
        ? sql`${column} IS NOT NULL`
        : sql`${column} IN ${shortcodeIdsSql(target, () => sql`true`)}`;
    const presenceSql = (presence: PresenceFilter) =>
      presence === undefined
        ? undefined
        : presence === "has"
          ? live
          : sql`NOT COALESCE((${live}), false)`;
    const presence =
      descriptor.kind === "presence"
        ? presenceFilter.parse(value)
        : descriptor.nullable
          ? presenceFilter.parse(values[descriptor.nullable.field])
          : undefined;
    const condition = (any: SQL | undefined): RowCondition[] =>
      any === undefined && presence === undefined
        ? []
        : [
            {
              any: or(any, presenceSql(presence)),
              all: null,
              presence: presenceSql(presence),
              absent: presence === "none",
            },
          ];
    switch (descriptor.kind) {
      case "presence":
        return condition(undefined);
      case "text": {
        const term = optionalText.parse(value)?.trim();
        if (!term) return [];
        const expander = Object.entries(
          generatedEntityListFields[entity].terms,
        ).find(([filter]) => filter === key)?.[1];
        const terms = expander ? listTermExpanders[expander](term) : [term];
        return condition(
          or(...terms.map((candidate) => formatSearchTerm(column, candidate))),
        );
      }
      case "boolean": {
        const flag = optionalBoolean.parse(value);
        return flag === undefined ? [] : condition(sql`${column} = ${flag}`);
      }
      default: {
        const picked = nonEmpty(optionalTextList.parse(value));
        const matches = (items: readonly string[]) =>
          target === undefined
            ? sql`${column} IN (${sql.join(
                items.map((item) => sql`${item}`),
                sql`, `,
              )})`
            : sql`${column} IN ${requestedIdsSql(
                target,
                items,
                subtreeToggle(entity, key, values),
              )}`;
        const all =
          descriptor.match !== null &&
          matchAll.parse(values[descriptor.match.field]);
        if (picked === undefined || !all)
          return condition(picked === undefined ? undefined : matches(picked));
        return [
          {
            any: or(matches(picked), presenceSql(presence)),
            all: picked.map((item) => matches([item])),
            presence: presenceSql(presence),
            absent: presence === "none",
          },
        ];
      }
    }
  });
  if (conditions.length === 0) return undefined;
  // No row at all, matched only when every condition asks for No value.
  const empty = (absent: boolean) =>
    absent ? sql`NOT ${set.exists(undefined)}` : undefined;
  const everyValue = conditions.filter(({ all }) => all !== null);
  if (everyValue.length === 0)
    return or(
      set.exists(and(...conditions.map(({ any }) => any))),
      empty(conditions.every(({ absent }) => absent)),
    );
  // Each value of a Match all filter needs its own row, which also holds
  // every sibling's any-of condition (another Match all filter's included).
  return and(
    ...everyValue.map((condition) => {
      const others = conditions.filter((other) => other !== condition);
      const siblings = and(...others.map(({ any }) => any));
      return or(
        and(
          ...(condition.all ?? []).map((each) =>
            set.exists(and(each, siblings)),
          ),
        ),
        condition.presence === undefined
          ? undefined
          : or(
              set.exists(and(condition.presence, siblings)),
              empty(condition.absent && others.every(({ absent }) => absent)),
            ),
      );
    }),
  );
};

const nonEmpty = <T>(list: readonly T[] | undefined) =>
  list === undefined || list.length === 0 ? undefined : list;

const dateRange = (
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
const rangeOrPresence = (
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
 * A range filter over a `dateInterval` value. Range bounds match overlap,
 * so a span that runs into the window from either side counts; a one-date
 * parameter (`activeOn`) matches containment. A NULL end is open; a NULL
 * start matches nothing.
 */
const intervalPredicate = (
  entity: Entity,
  derived: AnyDerivedSql,
  key: string,
  context: ListContext,
  descriptor: StoredDescriptorView,
  values: ListFilterValues,
): SQL | undefined => {
  const [low, high] =
    descriptor.wire.kind === "range"
      ? [
          optionalDate.parse(values[descriptor.wire.from]),
          optionalDate.parse(values[descriptor.wire.to]),
        ]
      : [
          optionalDate.parse(values[descriptor.wire.name]),
          optionalDate.parse(values[descriptor.wire.name]),
        ];
  if (low === undefined && high === undefined) return undefined;
  const { start, end } = derivedIntervalSql(entity, derived, key, context);
  return and(
    high === undefined ? undefined : sql`(${start}) <= ${high}::date`,
    low === undefined
      ? undefined
      : sql`((${end}) IS NULL OR (${end}) >= ${low}::date)`,
  );
};

/**
 * A pending field suggestion of any of the picked kinds, ORed with the
 * generated Any value (any pending suggestion) / No value (none).
 */
const suggestionPredicate = (
  entity: Entity,
  table: PgTable,
  kinds: readonly ("addition" | "correction")[],
  presence: PresenceFilter,
): SQL | undefined => {
  const pending = (kind: SQL) => sql`EXISTS (
    SELECT 1 FROM "AssessmentState" s
    INNER JOIN "Run" r ON r."id" = s."runId"
    WHERE s."entity" = ${entity}
      AND s."recordId" = ${sql.identifier(getTableName(table))}."id"
      AND s."status" = ${suggestionStatus.enum.pending}
      AND r."deletedAt" IS NULL
      AND (s."pairKey" IS NULL OR r."input"->>'decisionModel' = s."model")
      ${kind}
  )`;
  return or(
    kinds.length === 0
      ? undefined
      : pending(
          sql`AND s."kind" IN (${sql.join(
            kinds.map((kind) => sql`${kind}`),
            sql`, `,
          )})`,
        ),
    presence === undefined
      ? undefined
      : presence === "has"
        ? pending(sql``)
        : sql`NOT ${pending(sql``)}`,
  );
};

/**
 * The predicates of every declared filter. Text is a substring match ORed
 * across its `anyOf` fields (a `text[]` column matches by element, a `via`
 * path by any related record). A `stored` filter is the standard column
 * predicate for its kind: enum filters are equality or
 * membership with the declared nullable presence filter ORed in, a
 * multiselect declared `array` is an overlap with the same presence rule,
 * boolean is equality or presence, presence checks NULL, ranges are
 * inclusive bounds, and an id filter matches a foreign key by the referenced
 * row's shortcode. Anything richer (joins, OR groups across filters) is a
 * `model.derived` value or predicate whose SQL the repository supplies.
 */
export function declaredFilterPredicates<Filters extends object>(
  entity: Entity,
  table: PgTable & { id: AnyColumn },
  filters: Filters,
  derivedInput?: DerivedFilterInput,
): Array<SQL | undefined> {
  const hasSuggestTargets = fieldModelFor(entity)?.fields.some(
    (field) => field.control?.suggest != null,
  );
  const values = listFilterValues.parse(filters);
  const derivedDescriptors = descriptorsFor(entity).filter(
    (descriptor): descriptor is StoredDescriptorView & { derived: string } =>
      descriptor.derived !== null,
  );
  /** The row set a derived descriptor's `via` starts at, if any. */
  const rowSetOf = ({ derived }: { derived: string }) => {
    const field = derivedFieldsOf(entity)[derived];
    return field?.shape === "rows" ? field.rows : null;
  };
  const include = (values: ListFilterValues): Array<SQL | undefined> => [
    hasSuggestTargets
      ? suggestionPredicate(
          entity,
          table,
          suggestionKinds.parse(values.suggestionKind),
          presenceFilter.parse(values.suggestionPresenceFilter),
        )
      : undefined,
    ...derivedDescriptors
      .filter((descriptor) => rowSetOf(descriptor) === null)
      .flatMap((descriptor) =>
        derivedFilterPredicates(
          entity,
          table,
          descriptor,
          values,
          derivedInput,
        ),
      ),
    ...descriptorsFor(entity).map((descriptor) =>
      descriptor.anyOf === null
        ? undefined
        : anyOfPredicate(
            entity,
            table,
            descriptor,
            descriptor.anyOf,
            values,
            derivedInput,
          ),
    ),
    ...[...new Set(derivedDescriptors.map(rowSetOf))].flatMap((rows) =>
      rows === null
        ? []
        : [
            rowSetPredicates(
              entity,
              table,
              rows,
              derivedDescriptors.filter(
                (descriptor) => rowSetOf(descriptor) === rows,
              ),
              values,
            ),
          ],
    ),
    ...descriptorsFor(entity)
      .filter((descriptor) => descriptor.stored !== null)
      .flatMap((descriptor): Array<SQL | undefined> => {
        const key = descriptor.field ?? descriptor.columnId;
        const [column] = descriptor.stored?.columns ?? [];
        if (column === undefined) return [];
        const first = storedColumn(entity, table, descriptor, column);
        const value = values[key];
        const presence = descriptor.nullable
          ? presenceFilter.parse(values[descriptor.nullable.field])
          : undefined;
        switch (descriptor.kind) {
          case "boolean":
            return [booleanPredicate(first, optionalBoolean.parse(value))];
          case "multiselect":
            return [
              descriptor.stored?.array
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
                  : eqAnyOrPresence(first.column, value, presence),
            ];
          case "presence":
            return [
              presenceCondition(first.value, presenceFilter.parse(value)),
            ];
          case "idMulti":
            return [
              referencePredicate(
                entity,
                first,
                optionalTextList.parse(value),
                subtreeToggle(entity, key, values),
                presence,
              ),
            ];
          case "range": {
            if (descriptor.wire.kind !== "range")
              throw new Error(
                `${entity}.${descriptor.columnId} is a stored range without range wire keys`,
              );
            const { from, to, presence: presenceKey } = descriptor.wire;
            const presence =
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
            return [
              rangeOrPresence(and(...bounds), presence, (wanted) =>
                presenceCondition(first.value, wanted),
              ),
            ];
          }
          default:
            throw new Error(
              `${entity}.${descriptor.columnId} cannot derive a ${descriptor.kind} predicate`,
            );
        }
      }),
  ];
  return [
    ...include(values),
    ...excludedFilterRequests(entity, values).map((excluded) =>
      excludedPredicate(include(excluded)),
    ),
  ];
}

/**
 * The three boilerplate calls every entity list where-builder repeats —
 * `buildSearchConditions` + `declaredFilterPredicates`, `buildOrderBy` off the
 * generated sort roster, and `buildTakeSkip` — composed once per entity.
 *
 * A repository (`defineRepository`) keeps its own joins, cross-entity
 * subqueries, `readIntent` branches and row mappers, and only swaps in these
 * three calls. Every filter predicate is declared; `where` takes none by hand.
 */
/** Entities with a declared sort roster — the only ones `orderBy` can serve. */
type SortableEntity = keyof typeof generatedEntitySort;

/**
 * A list's ORDER BY options. Field order compiles from the declaration (stored
 * columns, `model.derived`, `related:<view>`, the quality score), so a
 * repository supplies only a group and its domain tie-breaker.
 */
interface ListOrderByOpts {
  tieBreaker?: SQL;
}

/** The already-built clauses a list's row query applies. */
export interface ListPage {
  where: SQL | undefined;
  orderBy: SQL[];
  limit: number;
  offset: number;
  /** The bulk quality relation `where`/`orderBy` read; a custom row select
   * that builds its own FROM must LEFT JOIN it. */
  qualityJoin?: { relation: SQL; on: SQL };
}

interface ListRequest<Filters extends object> {
  filters: Filters;
  sorts: SortParams[];
  pagination: PaginationParams;
  readIntent?: ListReadIntent;
  projection?: ListProjection;
}

/** What a list request reads, so `scaffold.context` prepares only that. */
export interface ListContextRequest<Filters extends object> {
  filters: Filters;
  sorts?: readonly SortParams[];
  readIntent?: ListReadIntent;
  projection?: ListProjection;
}

interface ListHydration<Row, Out> {
  /**
   * Rows → API items, batched over the page (quality, images, labels).
   * `context` holds the request's prepared derived-field data.
   */
  hydrate: (
    rows: Row[],
    projection: ListProjection,
    context: ListContext,
  ) => Promise<Out[]> | Out[];
  /** A context the repository already built for its own where-builder. */
  context?: ListContext;
  where?: SQL | undefined;
  tieBreaker?: SQL;
  orderBy?: SQL[];
  /** Joined lists can share a count/footer aggregate over their own FROM. */
  count?: () => Promise<number>;
  /**
   * The joins `where` reads beyond the root table, for the group summary
   * query; required with `count` when the list can group.
   */
  joins?: (query: PgSelect) => PgSelect;
}

type ListSpec<Row, Out> = ListHydration<Row, Out> &
  (
    | {
        /**
         * A plain-select projection with the same root FROM as count. Omit for
         * stored columns. Relational queries belong in `load`, never here.
         */
        select?: (page: ListPage, projection: ListProjection) => Promise<Row[]>;
        load?: never;
      }
    | {
        select?: never;
        /**
         * Enrich only the selected IDs. The scaffold owns filtering, sorting and
         * pagination in a plain FROM context, and restores page order afterward.
         */
        load: (
          where: SQL,
          projection: ListProjection,
        ) => Promise<Array<Row & { id: string }>>;
      }
  );

const searchableEntityNames = new Set<string>(searchableEntities);
const isSearchableEntity = (entity: string): entity is SearchableEntity =>
  searchableEntityNames.has(entity);
const scoredEntityNames = new Set<string>(scoredEntities);
const isScoredEntity = (entity: string): entity is ScoredEntity =>
  scoredEntityNames.has(entity);
const listSearchSchema = z
  .object({ searchQuery: z.string().trim().min(1).max(100).optional() })
  .passthrough();
const listIdsSchema = z
  .object({ ids: z.array(z.string()).optional() })
  .passthrough();
/** Shared by scaffold lists and repositories with a custom WHERE builder. */
const listIdsCondition = (shortcode: AnyColumn, filters: unknown) =>
  shortcodeSetCondition(sql`${shortcode}`, listIdsSchema.parse(filters).ids);

const listNestingCarrier = z
  .object({ nesting: listNestingSchema.optional() })
  .passthrough();
/**
 * The kernel's `filters.nesting` scope (`parseNesting`), carried beside the
 * entity's own filters like `ids`. Where-builders ignore it; `list` applies it.
 */
const listNestingFromFilters = (filters: unknown): ListNesting =>
  listNestingCarrier.parse(filters).nesting ?? { scope: "flat" };
const listRowIdSchema = z.object({ id: z.string() });

const listGroupByCarrier = z
  .object({
    groupBy: z.string().optional(),
    groupLevel: z.number().int().positive().optional(),
  })
  .passthrough();
/**
 * The kernel's validated `groupBy`, carried beside the entity's own filters
 * like `nesting`, so every repository's list groups without threading it.
 */
const listGroupByFromFilters = (filters: unknown): ListGroupBy | undefined => {
  const { groupBy, groupLevel } = listGroupByCarrier.parse(filters);
  return groupBy === undefined
    ? undefined
    : groupLevel === undefined
      ? { key: groupBy }
      : { key: groupBy, level: groupLevel };
};

/** `filters` carrying a kernel-validated Group by for `listScaffold`. */
export const withListGroupBy = <Filters extends object>(
  filters: Filters,
  groupBy: ListGroupBy | undefined,
): Filters =>
  groupBy === undefined
    ? filters
    : Object.assign(
        {},
        filters,
        { groupBy: groupBy.key },
        groupBy.level === undefined ? {} : { groupLevel: groupBy.level },
      );

const searchQueryFromFilters = <Filters extends object>(
  filters: Filters | undefined,
) => listSearchSchema.parse(filters ?? {}).searchQuery;

/** A group order part as page ORDER BY: ascending, no-value last. */
const groupOrderBy = (group: ListGroupSql): SQL[] =>
  group.order.map((part) => {
    const value =
      part === "key" ? group.key : part === "label" ? group.label : part;
    if (value === null) throw new Error("A group orders by an absent label");
    return sql`${value} asc nulls last`;
  });

const groupSummaryRow = z.object({
  key: z.string().nullable(),
  label: z.string().nullable(),
  count: z.number().int().positive(),
  subtree: z.boolean().nullable(),
});

/**
 * Every section of the filtered set in page order, with its count: the same
 * key and order the page query sorts by, so sections stay contiguous across
 * offset pages and each count matches its rows.
 */
const loadGroupSummaries = async (
  db: Database | DrizzleTransaction,
  group: ListGroupSql,
  source: PgTable | SQL,
  where: SQL | undefined,
  joins: ((query: PgSelect) => PgSelect) | undefined,
): Promise<ListGroupSummary[]> => {
  const parts = group.order.flatMap((part) =>
    typeof part === "string" ? [] : [part],
  );
  // Selected in this order, so GROUP BY and ORDER BY can name positions.
  const selection = {
    key: group.key,
    label: group.label ?? sql`null::text`,
    ...Object.fromEntries(parts.map((part, index) => [`o${index}`, part])),
    count: sql`count(*)::int`,
    subtree: group.subtree
      ? sql`bool_or(${group.subtree})`
      : sql`null::boolean`,
  };
  const position = (part: SQL | "key" | "label") =>
    part === "key" ? 1 : part === "label" ? 2 : 3 + parts.indexOf(part);
  // SAFETY: T extends PgTable; this erases only the generic FROM constraint.
  const query = unwrapDb(db).select(selection).from(source).$dynamic();
  const rows = await (joins ? joins(query) : query)
    .where(where)
    .groupBy(
      sql.raw(
        Array.from({ length: 2 + parts.length }, (_, index) => index + 1).join(
          ", ",
        ),
      ),
    )
    .orderBy(
      ...group.order.map((part) => sql.raw(`${position(part)} asc nulls last`)),
    );
  const { choice } = group;
  const options =
    choice.value !== null && "options" in choice.value
      ? choice.value.options
      : null;
  return z
    .array(groupSummaryRow)
    .parse(rows)
    .map(({ key, label, count, subtree }) => ({
      key: key ?? FILTER_NONE,
      label:
        key === null
          ? choice.noValueLabel
          : (label ??
            options?.find((option) => option.value === key)?.label ??
            key),
      count,
      ...(subtree === null ? {} : { subtree }),
    }));
};

interface ListScaffoldOptions<E extends Entity> {
  /** SQL for every declared `model.derived` value and predicate. */
  derived: DerivedSqlArg<E>;
}

/** `options` is required exactly when the entity declares derived SQL. */
type ListScaffoldArgs<E extends Entity> = [keyof DerivedSqlArg<E>] extends [
  never,
]
  ? [options?: ListScaffoldOptions<E>]
  : [options: ListScaffoldOptions<E>];

/**
 * `entity`/`table` scope the helpers to one entity's list. Call once per
 * repository (module scope is fine — request data lives in the
 * `scaffold.context` a request builds).
 */
export function listScaffold<
  E extends SortableEntity,
  T extends PgTable & {
    id: AnyColumn;
    deletedAt: AnyColumn;
    createdAt: AnyColumn;
    updatedAt: AnyColumn;
    shortcode: AnyColumn;
  },
>(entity: E, table: T, ...[options]: ListScaffoldArgs<E>) {
  const derivedSql: AnyDerivedSql = options?.derived ?? {};
  const derivedFields = derivedFieldsOf(entity);
  const fieldModel = fieldModelFor(entity);
  const readGroups = Object.entries(entitySummary).find(
    ([key]) => key === entity,
  )?.[1].list.read;
  /** Whether a projection reads the derived model field `key`. */
  const projects = (key: string, projection: ListProjection): boolean => {
    if (!fieldModel?.fields.some((field) => field.key === key)) return false;
    const group = (["quality", "media", "relations", "derived"] as const).find(
      (name) => readGroups?.[name]?.some((field) => field === key) === true,
    );
    return group === undefined
      ? projection.kind === "selected"
        ? projection.fields.includes(key)
        : projection.kind !== "enrichment"
      : wantsListGroup(projection, group);
  };
  const searchable = isSearchableEntity(entity);
  // A scored entity's `dataStatus`/`dataGap` filters and `dataQualityScore`
  // sort are declared by the manifest block, so they bind here for every
  // list at once rather than beside each repo's own conditions.
  const scored = isScoredEntity(entity) ? entity : null;
  const qualityContext = scored ? qualityFilterContext(scored) : undefined;
  const qualitySource: PgTable | SQL = scored
    ? qualityFilterSource(scored, table)
    : table;
  const scoreSort = scored
    ? dataQualitySortResolver(scored, table, qualityContext)
    : null;
  /** The self-reference a declared `list.tree` nests under. */
  const treeParent = (): AnyColumn => {
    const tree = Object.entries(entitySummary).find(
      ([key]) => key === entity,
    )?.[1].list.tree;
    if (!tree) throw new Error(`${entity} declares no list.tree to nest by`);
    const columns: Record<string, AnyColumn> = getTableColumns(table);
    const column = columns[tree.parentField];
    if (!column)
      throw new Error(
        `${entity}.list.tree.parentField ${tree.parentField} has no table column`,
      );
    return column;
  };
  /**
   * The nesting scope over `filtered` (the full filter where). The subqueries
   * re-read the same unaliased table, so every filter column inside them
   * binds to the inner row: "matches the filters" is judged per parent, over
   * the whole filtered set rather than a loaded page.
   */
  const nestingCondition = (
    nesting: Exclude<ListNesting, { scope: "flat" }>,
    parent: AnyColumn,
    filtered: SQL | undefined,
  ): SQL => {
    if (nesting.scope === "children") {
      const requested = shortcodeSetCondition(sql`${table.shortcode}`, [
        nesting.parentId,
      ]);
      return sql`${parent} IN (SELECT ${table.id} FROM ${table} WHERE ${requested})`;
    }
    // A row whose parent is absent, deleted, or filtered out is a root.
    return sql`(${parent} IS NULL OR ${parent} NOT IN (SELECT ${table.id} FROM ${qualitySource} WHERE ${filtered ?? sql`true`}))`;
  };
  /** Each listed parent's direct children that match `filtered`, by shortcode. */
  const childCounts = async (
    db: Database | DrizzleTransaction,
    parent: AnyColumn,
    filtered: SQL | undefined,
    codes: readonly string[],
  ): Promise<Map<string, number>> => {
    const name = sql.identifier(getTableName(table));
    const id = sql.identifier(table.id.name);
    const shortcode = sql.identifier(table.shortcode.name);
    // Qualified by hand: Drizzle may render a column bare, which inside the
    // aliased subquery would bind to `p` rather than the counted row.
    const parentOf = sql`${name}.${sql.identifier(parent.name)}`;
    const listed = shortcodeSetCondition(sql`p.${shortcode}`, codes);
    // SAFETY: T extends PgTable; this erases only the generic FROM constraint.
    const rows = await unwrapDb(db)
      .select({
        code: sql<string>`(SELECT p.${shortcode} FROM ${name} p WHERE p.${id} = ${parentOf})`,
        count: sql<number>`count(*)::int`,
      })
      .from(qualitySource)
      .where(
        and(
          filtered,
          sql`${parent} IN (SELECT p.${id} FROM ${name} p WHERE ${listed})`,
        ),
      )
      .groupBy(sql`${parent}`);
    return new Map(rows.map((row) => [row.code, row.count]));
  };
  const scaffold = {
    /**
     * Loads, once, the request data the requested derived fields read: a
     * field's `prepare` runs only when the request filters, sorts, groups or
     * projects on it, and fields sharing a handle share its result.
     */
    async context<Filters extends object>(
      db: Database | DrizzleTransaction,
      request: ListContextRequest<Filters>,
      // Data a caller already loaded for a prepare (a Problems sweep's
      // attention items), used instead of loading it again.
      seeded: ReadonlyArray<readonly [ListPrepare<unknown>, unknown]> = [],
    ): Promise<ListContext> {
      const values = listFilterValues.parse(request.filters);
      // An active filter reads its derived entry, or every derived member of
      // its `anyOf`.
      const filtered = new Set(
        descriptorsFor(entity).flatMap((descriptor) =>
          descriptorValueKeys(descriptor).some(
            (key) => values[key] !== undefined,
          )
            ? [
                ...(descriptor.derived === null ? [] : [descriptor.derived]),
                ...(descriptor.anyOf ?? []).flatMap(({ key, source }) =>
                  source === "derived" ? [key] : [],
                ),
              ]
            : [],
        ),
      );
      const counting = request.readIntent === "count";
      const requested = Object.keys(derivedFields).filter(
        (key) =>
          filtered.has(key) ||
          (!counting &&
            (request.sorts?.some((sort) => sort.orderBy === key) === true ||
              listGroupByFromFilters(request.filters)?.key === key ||
              projects(key, request.projection ?? { kind: "full" }))),
      );
      const prepares = new Set(
        requested.flatMap((key) => {
          const prepare = derivedPrepare(derivedSql, key);
          return prepare === null ? [] : [prepare];
        }),
      );
      const seeds = new Map<ListPrepare<unknown>, unknown>(seeded);
      const loaded = await Promise.all(
        [...prepares].map(
          async (prepare): Promise<[ListPrepare<unknown>, unknown]> => [
            prepare,
            seeds.has(prepare)
              ? seeds.get(prepare)
              : await prepare.load(db, values),
          ],
        ),
      );
      return new ListContext(new Map(loaded));
    },

    /**
     * Every list filter compiles from the declaration (stored, `model.derived`,
     * related views, quality, audit dates, ids, search); there is no
     * hand-written predicate argument. A list's static row scope is ANDed
     * with this by its repository.
     */
    where<Filters extends object>(
      filters: Filters,
      {
        context = ListContext.empty,
        readContext,
      }: { context?: ListContext; readContext?: QualityReadContext } = {},
    ): SQL | undefined {
      return buildSearchConditions(
        table,
        [],
        [
          // Only a caller's own read context reaches derived SQL; the
          // scaffold's quality join alias exists only beside its own FROM.
          ...scaffold.filterPredicates(filters, context.withRead(readContext)),
          ...(scored
            ? dataQualityFilterPredicates(
                scored,
                table,
                filters,
                readContext ?? qualityContext,
              )
            : []),
          ...auditDateWhereConditions(table, filters),
          // The declared related-view filters (`related-<key>`, `<prefix>Id`,
          // `<prefix>PresenceFilter`, `<prefix>Search`) for every list.
          ...relatedWhereConditions(entity, filters, table.id),
          // The kernel's `filters.ids` restriction, by canonical shortcode.
          listIdsCondition(table.shortcode, filters),
          ...(searchable
            ? [
                lexicalEligibility(
                  entity,
                  table.id,
                  searchQueryFromFilters(filters),
                ),
              ]
            : []),
        ],
      );
    },

    /**
     * The declared stored and derived filter predicates alone, for a
     * repository whose hand-written where-builder cannot use `where`.
     */
    filterPredicates<Filters extends object>(
      filters: Filters,
      context: ListContext = ListContext.empty,
    ): Array<SQL | undefined> {
      return declaredFilterPredicates(entity, table, filters, {
        derived: derivedSql,
        context,
      });
    },

    /** The request's validated `groupBy` as SQL, or null when ungrouped. */
    group<Filters extends object>(
      filters: Filters,
      context: ListContext = ListContext.empty,
    ): ListGroupSql | null {
      const groupBy = listGroupByFromFilters(filters);
      return groupBy === undefined
        ? null
        : groupSql(entity, groupBy, derivedSql, table, context);
    },

    /** A derived field's ORDER BY, or null when the field is not derived. */
    derivedSort(
      sort: SortParams,
      context: ListContext = ListContext.empty,
    ): SQL[] | null {
      return derivedOrderBy(entity, derivedSql, sort, table, context);
    },

    orderBy<Filters extends object>(
      sorts: SortParams[],
      opts?: ListOrderByOpts,
      filters?: Filters,
      context: ListContext = ListContext.empty,
    ): SQL[] {
      const searchQuery = searchQueryFromFilters(filters);
      return buildOrderBy(
        table,
        sorts,
        [...generatedEntitySort[entity].fields],
        {
          ...opts,
          leadingOrderBy:
            searchable && searchQuery !== undefined && sorts.length === 0
              ? [
                  asc(lexicalRelevance(entity, table.id, searchQuery)),
                  desc(table.updatedAt),
                ]
              : undefined,
          resolve: (sort) =>
            scoreSort?.(sort) ?? scaffold.derivedSort(sort, context),
          // Offset pagination must be deterministic. Repositories may keep a
          // domain-specific tie-breaker, but every explicit list sort then
          // lands on the public shortcode before the private primary key.
          tieBreaker: opts?.tieBreaker
            ? sql`${opts.tieBreaker}, ${table.shortcode} asc`
            : sql`${table.shortcode} asc`,
        },
      );
    },

    page(pagination: PaginationParams): { take: number; skip: number } {
      return buildTakeSkip(pagination);
    },

    /**
     * One list read: where → order → page → rows + count → hydrate. A
     * `count` read never runs the row query or hydration.
     */
    async list<Filters extends object, Out, Row = InferSelectModel<T>>(
      db: Database | DrizzleTransaction,
      request: ListRequest<Filters>,
      spec: ListSpec<Row, Out>,
    ): Promise<{ data: Out[]; count: number; groups?: ListGroupSummary[] }> {
      const readsQuality =
        scored !== null &&
        (hasDataQualityFilter(request.filters) ||
          request.sorts.some((sort) => sort.orderBy === "dataQuality"));
      // Keep the PgTable object: interpolating an aliased table into SQL
      // emits only its alias, while Drizzle's FROM builder names its origin.
      const source: PgTable | SQL = readsQuality ? qualitySource : table;
      const context = spec.context ?? (await scaffold.context(db, request));
      const filtered =
        "where" in spec
          ? spec.where
          : scaffold.where(request.filters, { context });
      const nesting = listNestingFromFilters(request.filters);
      const parent = nesting.scope === "flat" ? null : treeParent();
      if (parent && spec.count)
        throw new Error(`${entity} counts its own FROM and cannot nest`);
      const where =
        nesting.scope === "flat" || !parent
          ? filtered
          : and(filtered, nestingCondition(nesting, parent, filtered));
      const projection = request.projection ?? { kind: "full" };
      const { take, skip } = buildTakeSkip(request.pagination);
      const readIntent = request.readIntent ?? "page";
      // Sections lead the total order, so a page never splits a section the
      // summary query counts whole.
      const group =
        readIntent === "count"
          ? null
          : scaffold.group(request.filters, context);
      if (group && spec.count && !spec.joins)
        throw new Error(
          `${entity} counts its own FROM; pass its joins to group the list`,
        );
      const qualityJoin =
        readsQuality && scored ? qualityFilterJoin(scored, table) : undefined;
      const page: ListPage = {
        where,
        // A count never orders, and skipped the prepares a derived sort reads.
        orderBy:
          readIntent === "count"
            ? []
            : [
                ...(group ? groupOrderBy(group) : []),
                ...(spec.orderBy ??
                  scaffold.orderBy(
                    request.sorts,
                    { tieBreaker: spec.tieBreaker },
                    request.filters,
                    context,
                  )),
              ],
        limit: take,
        offset: skip,
        ...(qualityJoin ? { qualityJoin } : {}),
      };
      const load = spec.load;
      const loadIds = load
        ? async (
            ids: readonly string[],
            selected: ListProjection,
          ): Promise<Row[]> => {
            if (ids.length === 0) return [];
            const loaded = await load(inArray(table.id, [...ids]), selected);
            const byId = new Map(loaded.map((row) => [row.id, row]));
            return ids.flatMap((id) => {
              const row = byId.get(id);
              return row ? [row] : [];
            });
          }
        : undefined;
      const selectRows = loadIds
        ? async (
            clauses: ListPage,
            selected: ListProjection,
          ): Promise<Row[]> => {
            // SAFETY: T extends PgTable; this erases only the generic FROM constraint.
            const ids = await unwrapDb(db)
              .select({ id: sql<string>`${table.id}` })
              .from(source)
              .where(clauses.where)
              .orderBy(...clauses.orderBy)
              .limit(clauses.limit)
              .offset(clauses.offset);
            return loadIds(
              ids.map((row) => row.id),
              selected,
            );
          }
        : (spec.select ??
          (async (clauses: ListPage) => {
            // Keep Drizzle's root table and column decoders when a derived
            // relation joins the list; SELECT * would also return its fields.
            // SAFETY: T extends PgTable; erase only the generic FROM constraint.
            const root: PgTable = table;
            const query = unwrapDb(db)
              .select(getTableColumns(root))
              .from(root)
              .$dynamic();
            const join = clauses.qualityJoin;
            const selected = join
              ? query.leftJoin(join.relation, join.on)
              : query;
            // SAFETY: selecting only the root table's columns preserves Row,
            // including its Drizzle decoders; derived fields are not returned.
            return (await selected
              .where(clauses.where)
              .orderBy(...clauses.orderBy)
              .limit(clauses.limit)
              .offset(clauses.offset)) as Row[];
          }));
      const readLoadedPageWithCount =
        loadIds && !spec.count
          ? () =>
              traceListPageWithCount(async (span) => {
                // Keep the authoritative FROM, predicates and total order. A window
                // counts before LIMIT without a second evaluation of the filter.
                const ids = await unwrapDb(db)
                  .select({
                    id: sql<string>`${table.id}`,
                    total: sql<number>`count(*) OVER ()::int`,
                  })
                  .from(source)
                  .where(page.where)
                  .orderBy(...page.orderBy)
                  .limit(page.limit)
                  .offset(page.offset);
                // With a positive LIMIT, an empty first page proves the total is zero.
                // Later empty pages need a count because OFFSET may hide matches.
                const count =
                  ids[0]?.total ??
                  (page.offset === 0 && page.limit > 0
                    ? 0
                    : await countWhere(db, table, where, source));
                const data = await loadIds(
                  ids.map((row) => row.id),
                  projection,
                );
                span.setAttributes({
                  "db.result_count": data.length,
                  "db.total_count": count,
                  "list.rows": data.length,
                });
                return { data, count };
              })
          : undefined;
      return withListReadTracing(
        { entity, projection: projection.kind },
        async () => {
          const [{ data, count }, groups] = await Promise.all([
            readIntent !== "count" && readLoadedPageWithCount
              ? readLoadedPageWithCount()
              : executeListQueryWithCount({
                  kind: readIntent,
                  rows: () => selectRows(page, projection),
                  count:
                    spec.count ?? (() => countWhere(db, table, where, source)),
                }),
            group && readIntent === "page"
              ? loadGroupSummaries(db, group, source, where, spec.joins)
              : undefined,
          ]);
          const grouped = groups === undefined ? {} : { groups };
          if (readIntent === "count" || data.length === 0)
            return { data: [], count, ...grouped };
          return withListReadTracing({ rows: data.length }, async () => {
            const hydrated = await spec.hydrate(data, projection, context);
            if (!parent) return { data: hydrated, count, ...grouped };
            const codeOf = (row: Out) => {
              const { id } = listRowIdSchema.parse(row);
              return parseShortcode(id)?.shortcode ?? id;
            };
            const counts = await childCounts(
              db,
              parent,
              filtered,
              hydrated.map(codeOf),
            );
            return {
              // SAFETY: `codeOf` parsed each hydrated row as an object; adding
              // `childCount` keeps every field the row's `Out` type declares.
              data: hydrated.map(
                (row) =>
                  Object.assign({}, row as object, {
                    childCount: counts.get(codeOf(row)) ?? 0,
                  }) as Out,
              ),
              count,
              ...grouped,
            };
          });
        },
      );
    },
  };
  return scaffold;
}
