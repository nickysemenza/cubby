import { suggestionStatus } from "@cubby/schemas/ai";
/**
 * The one list module every repository composes: the declared stored-filter
 * predicates (`declaredFilterPredicates`) and the per-entity list scaffold
 * (`listScaffold`) that binds them with the data-quality filters, audit
 * dates, lexical search, the generated sort roster and paging.
 */
import { scoredEntities } from "@cubby/schemas/data-quality";
import type { Entity } from "@cubby/schemas/entity";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import {
  generatedEntityListFields,
  type GeneratedListScopeKey,
  type GeneratedListScopeTarget,
  type GeneratedRowSet,
} from "@cubby/schemas/entity-list-fields";
import {
  entityInspectorMetadata,
  entityManifest,
  entityMembership,
  type ShortcodeEntity,
} from "@cubby/schemas/entity-manifest";
import { generatedEntitySort } from "@cubby/schemas/entity-sort";
import { entitySummary } from "@cubby/schemas/entity-summary";
import { FILTER_NONE } from "@cubby/schemas/filter-sentinel-fields";
import {
  buildTakeSkip,
  listGroupByDimensionsSchema,
  type ListGroupMembership,
  type ListGroupSummary,
  type ListGroupBy,
  type ListNesting,
  listNestingSchema,
  listResultMembership,
  type PaginationParams,
  presenceFilter,
  type PresenceFilter,
  type SortParams,
} from "@cubby/schemas/pagination";
import { searchableEntities } from "@cubby/schemas/search";
import { parseShortcode } from "@cubby/shared";
import {
  type AnyColumn,
  and,
  asc,
  desc,
  getTableColumns,
  getTableName,
  inArray,
  type InferSelectModel,
  isNull,
  or,
  SQL,
  sql,
} from "drizzle-orm";
import type { PgColumn, PgSelect, PgTable } from "drizzle-orm/pg-core";
import { z } from "zod";

import type { ListFacet } from "~/contracts/entity-list.contract";
import type { ListEntity } from "~/entity/generated/entity-lists.gen";
import type { ListReadRow } from "~/entity/model/list-read-fields";
import type { Database, DrizzleTransaction } from "~/server/db";
import {
  effectiveFieldInSql,
  effectiveFieldSql,
  inheritedFieldOfColumn,
} from "~/server/db/computed/effective-field";
import { storedDerived } from "~/server/db/derived-declarations";
import {
  auditDateWhereConditions,
  buildOrderBy,
  buildSearchConditions,
  countWhere,
  executeListQueryWithCount,
  flagCondition,
  formatSearchTerm,
  type ListReadIntent,
  notDeleted,
  shortcodeSetCondition,
  unwrapDb,
} from "~/server/db/helpers";
import { executeListQueryWithoutCount } from "~/server/db/helpers/query";
import { registerReadPorts } from "~/server/entity-kernel/repo/read-ports";
import { createAppError } from "~/server/errors/app-error";
import { ENTITY_LIST_READ_SCHEMAS } from "~/server/generated/entity-lists.server.gen";
import { SHORTCODE_TABLE } from "~/server/generated/shortcode-tables.gen";
import { loadCurrentFieldOwnership } from "~/server/generic/assessment/repo/automatic-fields";
import type { QualityReadContext } from "~/server/generic/data-quality/repo/registry";
import {
  dataQualityFilterPredicates,
  dataQualitySortResolver,
} from "~/server/generic/data-quality/repo/sql";
import {
  loadPageStoredMeta,
  storedFieldAvailableSql,
  type PageStoredMeta,
} from "~/server/generic/derived/repo/read";
import type { PageFieldReadContexts } from "~/server/generic/derived/repo/read-context";
import { relatedWhereConditions } from "~/server/generic/entity-links/repo/related-view";
import type { EvidenceLoader } from "~/server/generic/field-explanation/repo/field-explanation-evidence";
import type { ListProjection } from "~/server/generic/list/repo/list-contracts";
import { withPageFields } from "~/server/generic/list/repo/page-fields";
import { listTermExpanders } from "~/server/generic/list/repo/terms";
import {
  lexicalEligibility,
  lexicalRelevance,
} from "~/server/generic/search/repo/search-lexical";
import type { SearchReadPort } from "~/server/generic/search/repo/search-read-port";
import {
  traceListPageWithCount,
  withListReadTracing,
} from "~/server/observability/list-read-tracing";

import {
  compileDeclaredFilters,
  type DeclaredFilterDescriptor,
  descriptorValueKeys,
  entitySubtreeToggle,
  type FilterColumn,
  isHierarchyEntity,
  matchAll,
  nonEmpty,
  optionalBoolean,
  optionalDate,
  optionalNumber,
  optionalText,
  optionalTextList,
  rangeBound,
  rangeOrPresence,
  requestedIdsSql,
  textPredicate,
} from "./declared-filters";
import {
  type DerivedSqlArg,
  derivedFieldsOf,
  derivedOrderBy,
  derivedPredicateSql,
  derivedPrepare,
  derivedIntervalSql,
  derivedValueSet,
  declaredRollup,
  declaredRollups,
  declaredResultProjections,
  derivedSelectSql,
  derivedValueSql,
  type AnyDerivedSql,
  groupSql,
  type ListGroupSql,
  listMetricSql,
  listFilterValues,
  type ListFilterValues,
  ListContext,
  type ListPreparationScope,
  type ListPrepare,
  type ListReader,
  relatedExistsSql,
  type AnyRowsSql,
  rowSetSql,
  rowsPrepare,
  type RowsSqlArg,
  shortcodeIdsSql,
} from "./field-compiler";
import { readGroupedQuery } from "./grouped-query";
import {
  listReadPlan,
  selectedListProjection,
  type ListPagePrefetch,
  type ListReadOptions,
} from "./list-projection";

const suggestionKinds = z
  .union([
    z.enum(["addition", "correction"]),
    z.array(z.enum(["addition", "correction"])),
  ])
  .optional()
  .transform((value) => (value === undefined ? [] : [value].flat()));

const descriptorsFor = (entity: Entity): readonly DeclaredFilterDescriptor[] =>
  Object.entries(entityInspectorMetadata).find(([key]) => key === entity)?.[1]
    .filterDescriptors ?? [];
const fieldModelFor = (entity: Entity) =>
  Object.entries(entityFieldModels).find(([key]) => key === entity)?.[1];

const storedColumn = (
  entity: Entity,
  table: PgTable,
  descriptor: DeclaredFilterDescriptor,
  key: string,
): FilterColumn => {
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

/** All declared stored scalar forms share the same membership readiness gate. */
const descriptorResultKey = (
  entity: Entity,
  descriptor: DeclaredFilterDescriptor,
): string | undefined => {
  const field = descriptor.derived
    ? derivedFieldsOf(entity)[descriptor.derived]
    : undefined;
  if (field && "requiresResult" in field && field.requiresResult)
    return field.requiresResult;
  if (field && "fromResult" in field && field.fromResult)
    return field.fromResult.key;
  const candidate =
    descriptor.derived ?? descriptor.field ?? descriptor.columnId;
  return (
    fieldModelFor(entity)?.fields.find((field) => field.key === candidate)
      ?.storedKey ?? (storedDerived(entity, candidate) ? candidate : undefined)
  );
};

const descriptorAvailabilitySql = (
  entity: Entity,
  table: PgTable & { id: AnyColumn },
  descriptor: DeclaredFilterDescriptor,
  input?: DerivedFilterInput,
): SQL | null => {
  const key = descriptorResultKey(entity, descriptor);
  if (!key) return null;
  const field = descriptor.derived
    ? derivedFieldsOf(entity)[descriptor.derived]
    : undefined;
  // Contextual predicate adapters already return NULL only when their policy cannot decide.
  if (field?.shape === "predicate") return null;
  const source = derivedFieldsOf(entity)[key];
  const directScalar =
    source?.shape === "value" && !source.fromResult && !source.requiresResult;
  const value = directScalar
    ? derivedValueSql(
        entity,
        input?.derived ?? {},
        key,
        input?.context ?? ListContext.empty,
      )
    : undefined;
  const available = storedFieldAvailableSql(
    entity,
    key,
    table.id,
    value ? { currentValue: value } : {},
  );
  if (!available) return null;
  // Contextual adapters return NULL when undecided; cheap decisive values remain immediate.
  const current =
    field?.shape === "value" && field.requiresResult && descriptor.derived
      ? derivedValueSql(
          entity,
          input?.derived ?? {},
          descriptor.derived,
          input?.context ?? ListContext.empty,
        )
      : value;
  return current ? sql`(${current} IS NOT NULL OR ${available})` : available;
};

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
  descriptor: DeclaredFilterDescriptor,
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
  /** Repository row sets' relations. */
  readonly rows?: AnyRowsSql;
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
  descriptor: DeclaredFilterDescriptor,
  members: NonNullable<DeclaredFilterDescriptor["anyOf"]>,
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
  descriptor: DeclaredFilterDescriptor & { derived: string },
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
      case "boolean": {
        const flag = optionalBoolean.parse(value);
        if (flag === undefined) return [];
        const predicate = flagCondition(
          flag,
          () =>
            test((column) => sql`COALESCE((${column}), false)`) ?? sql`false`,
        );
        return [predicate];
      }
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
  table: PgTable & { id: AnyColumn },
  rows: string,
  descriptors: readonly (DeclaredFilterDescriptor & { derived: string })[],
  values: ListFilterValues,
  input: DerivedFilterInput | undefined,
): SQL | undefined => {
  const set = rowSetSql(
    entity,
    rows,
    getTableName(table),
    input?.rows,
    input?.context,
  );
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
      // Bounds on the shared row. A related view's range (product tasks by
      // due date) leaves its presence key to the view, which reads "has any
      // related record", not "has a value".
      case "range": {
        if (descriptor.wire.kind !== "range") return [];
        const [low, high] = [
          rangeBound.parse(values[descriptor.wire.from]),
          rangeBound.parse(values[descriptor.wire.to]),
        ];
        const bounds = and(
          low === undefined ? undefined : sql`${column} >= ${low}`,
          high === undefined ? undefined : sql`${column} <= ${high}`,
        );
        return bounds === undefined
          ? []
          : [{ any: bounds, all: null, presence: undefined, absent: false }];
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
  // No row at all also matches when every condition asks for No value.
  const matches = (condition: SQL | undefined, absent: boolean) =>
    absent ? set.matchesOrEmpty(condition) : set.matches(condition);
  const everyValue = conditions.filter(({ all }) => all !== null);
  const predicate =
    everyValue.length === 0
      ? matches(
          and(...conditions.map(({ any }) => any)),
          conditions.every(({ absent }) => absent),
        )
      : // Each value of a Match all filter needs its own row, which also holds
        // every sibling's any-of condition (another Match all filter's included).
        and(
          ...everyValue.map((condition) => {
            const others = conditions.filter((other) => other !== condition);
            const siblings = and(...others.map(({ any }) => any));
            return or(
              and(
                ...(condition.all ?? []).map((each) =>
                  set.matches(and(each, siblings)),
                ),
              ),
              condition.presence === undefined
                ? undefined
                : matches(
                    and(condition.presence, siblings),
                    condition.absent && others.every(({ absent }) => absent),
                  ),
            );
          }),
        );
  const available = and(
    ...descriptors.flatMap((descriptor) => {
      if (
        !descriptorValueKeys(descriptor).some(
          (key) => values[key] !== undefined,
        )
      )
        return [];
      const key = descriptorResultKey(entity, descriptor);
      const readiness = key
        ? storedFieldAvailableSql(entity, key, table.id)
        : null;
      return readiness ? [readiness] : [];
    }),
  );
  if (!available || !predicate) return predicate;
  // A present positive row proves its match immediately. Absence needs a completed result.
  const positive = conditions.every(({ absent }) => absent)
    ? sql`false`
    : predicate;
  return sql`CASE WHEN ${positive} THEN true WHEN ${available} THEN COALESCE(${predicate}, false) ELSE NULL::boolean END`;
};

/**
 * Every request key the filters and related scopes through one row set (or
 * one of its terminals) read, with the filters' "Include sub-…" toggles:
 * what a repository row set drops from the request that bounds its own
 * relation, which cannot read itself, and which of its columns a request
 * reads.
 */
export const rowSetFilterKeys = (
  entity: Entity,
  rows: string,
  terminal?: string,
): string[] => [
  ...descriptorsFor(entity).flatMap((descriptor) => {
    const field =
      descriptor.derived === null
        ? undefined
        : derivedFieldsOf(entity)[descriptor.derived];
    if (
      field?.shape !== "rows" ||
      field.rows !== rows ||
      (terminal !== undefined && field.path !== `${rows}.${terminal}`)
    )
      return [];
    const toggle = Object.entries(
      generatedEntityListFields[entity].subtree,
    ).find(
      ([filter]) => filter === (descriptor.field ?? descriptor.columnId),
    )?.[1];
    return [
      ...descriptorValueKeys(descriptor),
      ...(toggle === undefined ? [] : [toggle]),
    ];
  }),
  ...Object.entries(generatedEntityListFields[entity].scopes).flatMap(
    ([key, { via }]) =>
      via.shape === "rows" &&
      via.rows === rows &&
      (terminal === undefined || via.path === `${rows}.${terminal}`)
        ? [key]
        : [],
  ),
];

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
  descriptor: DeclaredFilterDescriptor,
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
      AND ${notDeleted("r")}
      AND COALESCE((s.data->>'served')::boolean, true)
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
  membership: "certain" | "possible" = "certain",
): Array<SQL | undefined> {
  const hasSuggestTargets = fieldModelFor(entity)?.fields.some(
    (field) => field.control?.suggest != null,
  );
  const values = listFilterValues.parse(filters);
  const derivedDescriptors = descriptorsFor(entity).filter(
    (
      descriptor,
    ): descriptor is DeclaredFilterDescriptor & { derived: string } =>
      descriptor.derived !== null,
  );
  /** The row set a derived descriptor's `via` starts at, if any. */
  const rowSetOf = ({ derived }: { derived: string }) => {
    const field = derivedFieldsOf(entity)[derived];
    return field?.shape === "rows" ? field.rows : null;
  };
  return compileDeclaredFilters(
    {
      label: entity,
      descriptors: descriptorsFor(entity),
      column: (descriptor, key) => storedColumn(entity, table, descriptor, key),
      subtree: entitySubtreeToggle(entity),
      extra: (values, excluding, mode) => {
        const input =
          excluding && derivedInput
            ? { ...derivedInput, context: derivedInput.context.excluding() }
            : derivedInput;
        return [
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
            .flatMap((descriptor) => {
              const field = derivedFieldsOf(entity)[descriptor.derived];
              return derivedFilterPredicates(
                entity,
                table,
                descriptor,
                values,
                input,
              ).map((predicate) => {
                if (
                  !predicate ||
                  !descriptorResultKey(entity, descriptor) ||
                  !field
                )
                  return predicate;
                const available = descriptorAvailabilitySql(
                  entity,
                  table,
                  descriptor,
                  input,
                );
                const outcome = available
                  ? sql`CASE WHEN ${available} THEN COALESCE(${predicate}, false) ELSE NULL::boolean END`
                  : predicate;
                return mode === "certain"
                  ? sql`(${outcome}) IS TRUE`
                  : sql`(${outcome}) IS NOT FALSE`;
              });
            }),
          ...descriptorsFor(entity).map((descriptor) =>
            descriptor.anyOf === null
              ? undefined
              : anyOfPredicate(
                  entity,
                  table,
                  descriptor,
                  descriptor.anyOf,
                  values,
                  input,
                ),
          ),
          ...[...new Set(derivedDescriptors.map(rowSetOf))].flatMap((rows) =>
            rows === null
              ? []
              : (() => {
                  const predicate = rowSetPredicates(
                    entity,
                    table,
                    rows,
                    derivedDescriptors.filter(
                      (descriptor) => rowSetOf(descriptor) === rows,
                    ),
                    values,
                    input,
                  );
                  return [
                    predicate === undefined
                      ? undefined
                      : mode === "certain"
                        ? sql`(${predicate}) IS TRUE`
                        : sql`(${predicate}) IS NOT FALSE`,
                  ];
                })(),
          ),
        ];
      },
    },
    values,
    membership,
  );
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
}

interface ListRequest<Filters extends object> {
  filters: Filters;
  sorts: SortParams[];
  pagination: PaginationParams;
  /** Existing callers retain exact counts; browser rosters may select one extra row. */
  includeCount?: boolean;
  readIntent?: ListReadIntent;
  projection?: ListProjection;
  /** Shares prepared derived data across the reads of one request. */
  preparation?: ListPreparationScope;
  /** Who reads and the clients loaders may call (`context.reader`). */
  reader?: ListReader;
}

/** What a list request reads, so `scaffold.context` prepares only that. */
export interface ListContextRequest<Filters extends object> {
  preparation?: ListPreparationScope;
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
  derived?: boolean;
  hydrate: (
    rows: Row[],
    projection: ListProjection,
    context: ListContext,
    prefetched?: ListPagePrefetch,
  ) => Promise<Out[]> | Out[];
  /** Start the page's id-only hydration loads; see `listReadPlan.prefetch`. */
  prefetch?: (
    ids: readonly string[],
    projection: ListProjection,
  ) => ListPagePrefetch;
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

type ListSpec<Row, Out> = ListHydration<Row, Out> & ListSelection<Row>;
type ListSelection<Row> =
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
    };

const isSearchableEntity = entityMembership(searchableEntities).has;
const isScoredEntity = entityMembership(scoredEntities).has;
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
const listResultMembershipCarrier = z
  .object({ resultMembership: listResultMembership.optional() })
  .passthrough();
const listRowIdSchema = z.object({ id: z.string() });
const selectionCursorSchema = z
  .object({
    after: z.string().min(1),
    fingerprint: z.string().regex(/^[0-9a-f]{32}$/),
  })
  .strict();
const selectionPageSchema = z.object({
  ids: z.array(z.string()),
  totalCount: z.number().int().nonnegative(),
  fingerprint: z.string(),
});

const listGroupByCarrier = z
  .object({ groupBy: listGroupByDimensionsSchema.optional() })
  .passthrough();
const listGroupByFromFilters = (filters: unknown): ListGroupBy[] =>
  listGroupByCarrier.parse(filters).groupBy ?? [];

/** Carries the validated ordered dimensions beside the entity filters. */
export const withListGroupBy = <Filters extends object>(
  filters: Filters,
  groupBy: readonly ListGroupBy[] | undefined,
): Filters =>
  groupBy === undefined ? filters : Object.assign({}, filters, { groupBy });

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

/**
 * The list a related scope (`presentation.list.scopes`) nests: its prepared
 * data for the nested filter record, and the live records that record
 * selects.
 */
export interface NestedListScaffold<T extends Entity> {
  readonly entity: T;
  context(
    db: Database | DrizzleTransaction,
    request: ListContextRequest<ListFilterValues>,
  ): Promise<ListContext>;
  matchingIds(
    filters: ListFilterValues,
    options: { context: ListContext; membership?: "certain" | "possible" },
  ): SQL;
  hasResultFilters(filters: ListFilterValues): boolean;
}

/**
 * The target list of every related scope the entity declares, read when a
 * request first sets the scope: the target's repository may import this
 * one's, so its scaffold need not exist yet when this one is built.
 */
type ScopesArg<E extends Entity> = {
  readonly [K in GeneratedListScopeKey<E>]: () => NestedListScaffold<
    GeneratedListScopeTarget<E, K>
  >;
};

/**
 * SQL for every declared `model.derived` value and predicate, the relation
 * of every repository row set (`model.rows`), and the target list of every
 * related scope; each key is required exactly when the entity declares one.
 */
type ListScaffoldOptions<E extends Entity, Row> = ([
  keyof DerivedSqlArg<E>,
] extends [never]
  ? { derived?: DerivedSqlArg<E> }
  : { derived: DerivedSqlArg<E> }) &
  ([keyof RowsSqlArg<E>] extends [never]
    ? { rows?: RowsSqlArg<E> }
    : { rows: RowsSqlArg<E> }) &
  ([GeneratedListScopeKey<E>] extends [never]
    ? { scopes?: ScopesArg<E> }
    : { scopes: ScopesArg<E> }) & {
    /** Join-implied population constraints shared by rows, facets, and identity reads. */
    population?: <Filters extends object>(filters: Filters) => SQL;
    /** Request options consumed by population rather than tested against each row. */
    populationFilters?: readonly (keyof DerivedSqlArg<E>)[];
    /** How a page and a single record read their rows; see {@link ListReadDeclaration}. */
    read?: ListReadDeclaration<Row>;
  };

/**
 * The entity's read, stated once: list pages, selected projections and the
 * single-record read all select through it. Stored columns and every
 * declared derived value with one expression are selected without restating
 * them; `columns` adds the read keys that are neither, and the helper
 * columns a binding reads.
 */
type ListReadDeclaration<Row> = ListReadOptions<Row> & {
  title?: SQL;
  optionCount?: string;
  optionKind?: PgColumn;
  evidence?: Readonly<Record<string, EvidenceLoader>>;
  search?: SearchReadPort;
  columns?: Readonly<
    Record<string, SQL | PgColumn | ((context: ListContext) => SQL)>
  >;
  /**
   * Rows by id when one plain select over the root table cannot read them
   * (relation-loaded children). The scaffold selects, orders and pages the
   * ids; `where` restricts to them.
   */
  load?: (
    db: Database | DrizzleTransaction,
    where: SQL,
    projection: ListProjection,
    context: ListContext,
  ) => Promise<Array<Row & { id: string }>>;
  /** A domain tie-breaker ahead of the shortcode for explicit sorts. */
  tieBreaker?: SQL;
  /**
   * An order the request's filters impose over any sort (an image Run's
   * capture order); undefined leaves the declared sorts in charge.
   */
  orderBy?: (filters: ListFilterValues) => SQL[] | undefined;
};

/** `options` is required exactly when the entity declares SQL it reads. */
type ListScaffoldArgs<E extends Entity, Row> = [
  keyof DerivedSqlArg<E> | keyof RowsSqlArg<E> | GeneratedListScopeKey<E>,
] extends [never]
  ? [options?: ListScaffoldOptions<E, Row>]
  : [options: ListScaffoldOptions<E, Row>];

const scopeValue = listFilterValues.optional();

/**
 * Static SQL for an explicitly opted-in repository reference connection,
 * read from the entity's own scaffold (its repository port).
 */
export const repositoryConnectionRows = (
  scaffold: { entity: Entity; repositoryRows(key: string): SQL },
  key: string,
  column: string,
): SQL => {
  const { entity } = scaffold;
  const rowSet: GeneratedRowSet | undefined = Object.entries(
    generatedEntityListFields[entity].rows,
  ).find(([name]) => name === key)?.[1];
  if (
    rowSet?.storage.kind !== "repository" ||
    !rowSet.storage.columns[column] ||
    !rowSet.storage.connections.includes(column)
  )
    throw new Error(
      `${entity}.model.rows.${key}.${column} is not a declared repository reference with connection: true`,
    );
  return scaffold.repositoryRows(key);
};

/** The canonical list read schema's entity, or null for a non-list entity. */
const listEntityOf = (entity: Entity): ListEntity | null =>
  Object.keys(ENTITY_LIST_READ_SCHEMAS).find(
    (key): key is ListEntity =>
      key === entity && Object.hasOwn(ENTITY_LIST_READ_SCHEMAS, key),
  ) ?? null;

/**
 * `entity`/`table` scope the helpers to one entity's list. Build once per
 * repository and hand it to `defineRepository` as the `scaffold` port; no
 * generic module reaches a scaffold any other way.
 */
export function listScaffold<
  E extends SortableEntity,
  T extends PgTable & {
    id: AnyColumn;
    deletedAt?: AnyColumn;
    createdAt: AnyColumn;
    updatedAt: AnyColumn;
    shortcode: AnyColumn;
  },
  Row = InferSelectModel<T> & ListReadRow,
>(entity: E, table: T, ...[options]: ListScaffoldArgs<E, Row>) {
  // Declared rollups compile from the manifest; a repository supplies only
  // the remaining value and predicate SQL.
  const derivedSql: AnyDerivedSql = {
    ...declaredRollups(entity, table),
    ...declaredResultProjections(entity, table.id),
    ...options?.derived,
  };
  const rowsSql: AnyRowsSql = options?.rows ?? {};
  const derivedFields = derivedFieldsOf(entity);
  const listFields = generatedEntityListFields[entity];
  // The static scope: declared columns pinned to NULL on every read.
  const tableColumns: AnyColumn[] = Object.values(getTableColumns(table));
  const staticScope = listFields.scope.map((name) => {
    const column = tableColumns.find((candidate) => candidate.name === name);
    if (column === undefined)
      throw new Error(`${entity}.presentation.list.scope: no column ${name}`);
    return isNull(column);
  });
  const nestedScaffolds: Readonly<
    Record<string, () => NestedListScaffold<Entity>>
  > = options?.scopes ?? {};
  /** Each related scope the request sets, with its nested filter record. */
  const requestedScopes = (values: ListFilterValues) =>
    Object.entries(listFields.scopes).flatMap(([key, scope]) => {
      const value = scopeValue.parse(values[key]);
      if (value === undefined) return [];
      const nested = nestedScaffolds[key]?.();
      if (nested === undefined || nested.entity !== scope.filters)
        throw new Error(
          `${entity}.presentation.list.scopes.${key} needs the ${scope.filters} list scaffold in listScaffold's scopes argument`,
        );
      return [{ via: scope.via, nested, value }];
    });
  const fieldModel = fieldModelFor(entity);
  const readDeclaration: ListReadDeclaration<Row> = options?.read ?? {};
  const listEntity = listEntityOf(entity);
  let plan: ReturnType<typeof listReadPlan<Row>> | undefined;
  // Built on first use: repository modules are evaluated while the generated
  // read schemas may still be initializing.
  const readPlan = () => {
    if (!listEntity) throw new Error(`No canonical list schema: ${entity}`);
    if (plan) return plan;
    plan = listReadPlan<Row>(listEntity, readDeclaration);
    // A read-schema key that no column, derived value, declared column or
    // binding loads would parse as absent on every read; refuse the plan.
    const missing = plan.unloaded(
      readDeclaration.load
        ? undefined
        : new Set([
            ...Object.keys(getTableColumns(table)),
            ...Object.keys(derivedFields),
            ...Object.keys(readDeclaration.columns ?? {}),
          ]),
    );
    if (missing.length)
      throw new Error(
        `${entity} read schema keys nothing loads: ${missing.join(", ")}`,
      );
    return plan;
  };
  /** The keys a page loads unless a projection names others. */
  const pageFields = (): ListProjection =>
    listEntity ? readPlan().fields.list : [];
  // Internal filter-only rows can require tokens absent from an ordinary page.
  const projects = (key: string, projection: ListProjection): boolean =>
    fieldModel?.fields.some((field) => field.key === key) === true &&
    projection.includes(key);
  /** Stored columns, declared derived values and declared columns a projection reads. */
  const readColumns = (projection: ListProjection, context: ListContext) => {
    const wanted = new Set(projection);
    const schema = listEntity
      ? ENTITY_LIST_READ_SCHEMAS[listEntity].schema
      : null;
    const selected = new Map<string, SQL | PgColumn>(
      Object.entries(getTableColumns(table)),
    );
    for (const key of Object.keys(derivedFields)) {
      if (!wanted.has(key) || Object.hasOwn(readDeclaration.columns ?? {}, key))
        continue;
      const value = derivedSelectSql(entity, derivedSql, key, context);
      if (value !== null) selected.set(key, value);
    }
    for (const [key, value] of Object.entries(readDeclaration.columns ?? {}))
      // A key outside the read schema is a helper column a binding reads.
      if (wanted.has(key) || !schema || !Object.hasOwn(schema.shape, key))
        selected.set(key, typeof value === "function" ? value(context) : value);
    return Object.fromEntries(selected);
  };
  /** The declared read's rows for `where`, in no particular order. */
  const readRows = (
    db: Database | DrizzleTransaction,
    context: ListContext,
  ):
    | {
        load: NonNullable<
          Extract<ListSelection<Row>, { load: unknown }>["load"]
        >;
        select?: never;
      }
    | {
        select: NonNullable<
          Extract<
            ListSelection<Row>,
            { select?: unknown; load?: never }
          >["select"]
        >;
        load?: never;
      } => {
    const load = readDeclaration.load;
    if (load)
      return {
        load: (where, projection) => load(db, where, projection, context),
      };
    return {
      select: async (page, projection) =>
        // SAFETY: the selection is the root table's columns plus the read's
        // declared SQL, which is what `Row` describes.
        (await unwrapDb(db)
          .select(readColumns(projection, context))
          .from(listTable)
          .where(page.where)
          .orderBy(...page.orderBy)
          .limit(page.limit)
          .offset(page.offset)) as Row[],
    };
  };
  const searchable = isSearchableEntity(entity);
  // A scored entity's `dataStatus`/`dataGap` filters and `dataQualityScore`
  // sort are declared by the manifest block, so they bind here for every
  // list at once rather than beside each repo's own conditions.
  const scored = isScoredEntity(entity) ? entity : null;
  const scoreSort = scored ? dataQualitySortResolver(scored, table) : null;
  // SAFETY: T extends PgTable; this erases only the generic FROM constraint.
  const listTable: PgTable = table;
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
    return sql`(${parent} IS NULL OR ${parent} NOT IN (SELECT ${table.id} FROM ${table} WHERE ${filtered ?? sql`true`}))`;
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
      .from(listTable)
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
    entity,

    repositoryRows(key: string): SQL {
      const entry = rowsSql[key];
      if (!(entry instanceof SQL))
        throw new Error(
          `${entity}.model.rows.${key}: connections require static repository SQL in listScaffold's rows argument; ${entry === undefined ? "no SQL was registered" : "prepared rows are not supported"}`,
        );
      return entry;
    },

    /**
     * The live records `filters` selects, as an id subquery: what a related
     * scope of another list matches through its path.
     */
    matchingIds(
      filters: ListFilterValues,
      {
        context,
        membership = "certain",
      }: { context: ListContext; membership?: "certain" | "possible" },
    ): SQL {
      return sql`(SELECT ${table.id} FROM ${table} WHERE ${
        scaffold.where(filters, { context, membership }) ?? sql`true`
      })`;
    },

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
      // `projection: false` loads only what the query itself reads (filters,
      // sorts, grouping); `nested: false` skips related scopes a seeded
      // query context already loaded.
      { projection = true, nested: loadNested = true } = {},
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
              listGroupByFromFilters(request.filters).some(
                (dimension) => dimension.key === key,
              ) ||
              (listGroupByFromFilters(request.filters).length > 0 &&
                generatedEntityListFields[entity].metrics.some(
                  (metric) => metric.key === key,
                )) ||
              (projection &&
                projects(key, request.projection ?? pageFields())))),
      );
      const scopes = requestedScopes(values);
      const prepares = new Set(
        [
          ...requested.map((key) => {
            const field = derivedFields[key];
            return field?.shape === "rows"
              ? rowsPrepare(rowsSql, field.rows)
              : derivedPrepare(derivedSql, key);
          }),
          // A related scope through a row set reads that set.
          ...scopes.map(({ via }) =>
            via.shape === "rows" ? rowsPrepare(rowsSql, via.rows) : null,
          ),
        ].filter((prepare) => prepare !== null),
      );
      const seeds = new Map<ListPrepare<unknown>, unknown>(seeded);
      const loaded = await Promise.all(
        [...prepares].map(
          async (prepare): Promise<[ListPrepare<unknown>, unknown]> => [
            prepare,
            seeds.has(prepare)
              ? seeds.get(prepare)
              : await (request.preparation
                  ? request.preparation.load(prepare, db, values)
                  : prepare.load(db, values)),
          ],
        ),
      );
      // A related scope's list prepares its own data, only when the request
      // sets that scope.
      const nested = await Promise.all(
        (loadNested ? scopes : []).map(({ nested, value }) =>
          nested.context(db, {
            filters: value,
            readIntent: "count",
            preparation: request.preparation,
          }),
        ),
      );
      return nested.reduce(
        (context, scope) => context.with(scope),
        new ListContext(new Map(loaded)),
      );
    },

    /**
     * The filter WHERE with the context it reads prepared for a count: what
     * a caller outside a page read (dashboards, work sources, sweeps) needs.
     */
    async prepareWhere<Filters extends object>(
      db: Database | DrizzleTransaction,
      filters: Filters,
      seeded: ReadonlyArray<readonly [ListPrepare<unknown>, unknown]> = [],
      readContext?: QualityReadContext,
    ): Promise<SQL | undefined> {
      const context = await scaffold.context(
        db,
        { filters, readIntent: "count" },
        seeded,
      );
      return scaffold.where(filters, {
        context,
        readContext,
      });
    },

    /**
     * Every list filter compiles from the declaration (stored, `model.derived`,
     * related views, quality, audit dates, ids, search), and so do the list's
     * declared scopes. A repository's join-implied population predicate is
     * shared here so identity readers and row readers cannot diverge.
     */
    where<Filters extends object>(
      filters: Filters,
      {
        context = ListContext.empty,
        readContext,
        membership,
      }: {
        context?: ListContext;
        readContext?: QualityReadContext;
        membership?: "certain" | "possible";
      } = {},
    ): SQL | undefined {
      if (
        membership === undefined &&
        listResultMembershipCarrier.parse(filters).resultMembership ===
          "unresolved"
      )
        return scaffold.unresolvedWhere(filters, context.withRead(readContext));
      return buildSearchConditions(
        table,
        [],
        [
          options?.population?.(filters),
          // Only a caller's own read context reaches derived SQL.
          ...scaffold.filterPredicates(
            filters,
            context.withRead(readContext),
            membership,
          ),
          ...(scored
            ? dataQualityFilterPredicates(scored, table, filters)
            : []),
          ...auditDateWhereConditions(table, filters),
          // The declared related-view filters (`related-<key>`, `<prefix>Id`,
          // `<prefix>PresenceFilter`, `<prefix>Search`) for every list.
          ...relatedWhereConditions(entity, filters, table.id),
          // The kernel's `filters.ids` restriction, by canonical shortcode.
          listIdsCondition(table.shortcode, filters),
          ...staticScope,
          ...requestedScopes(listFilterValues.parse(filters)).map(
            ({ via, nested, value }) => {
              const scopeContext = context.withRead(undefined);
              const ids = nested.matchingIds(value, {
                context: scopeContext,
                membership: membership ?? "certain",
              });
              if (via.shape === "via")
                return relatedExistsSql(
                  entity,
                  via,
                  table.id,
                  (leaf) => sql`${leaf}."id" IN ${ids}`,
                );
              const set = rowSetSql(
                entity,
                via.rows,
                getTableName(table),
                rowsSql,
                scopeContext,
              );
              return set.matches(sql`${set.column(via)} IN ${ids}`);
            },
          ),
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
      membership: "certain" | "possible" = "certain",
    ): Array<SQL | undefined> {
      const values = options?.populationFilters
        ? Object.fromEntries(
            Object.entries(filters).filter(
              ([key]) =>
                !options.populationFilters?.some((field) => field === key),
            ),
          )
        : filters;
      return declaredFilterPredicates(
        entity,
        table,
        values,
        {
          derived: derivedSql,
          rows: rowsSql,
          context,
        },
        membership,
      );
    },

    /** Candidates whose requested membership awaits a declared stored result. */
    unresolvedWhere<Filters extends object>(
      filters: Filters,
      context: ListContext = ListContext.empty,
    ): SQL {
      const certain = scaffold.where(filters, {
        context,
        membership: "certain",
      });
      const possible = scaffold.where(filters, {
        context,
        membership: "possible",
      });
      return sql`(${possible ?? sql`true`}) IS TRUE AND (${certain ?? sql`true`}) IS NOT TRUE`;
    },

    /** Includes nested scope dependencies rather than only this entity's explicit roots. */
    hasResultFilters<Filters extends object>(filters: Filters): boolean {
      const values = listFilterValues.parse(filters);
      return (
        descriptorsFor(entity).some(
          (descriptor) =>
            descriptorResultKey(entity, descriptor) !== undefined &&
            descriptorValueKeys(descriptor).some(
              (key) => values[key] !== undefined,
            ),
        ) ||
        requestedScopes(values).some(({ nested, value }) =>
          nested.hasResultFilters(value),
        )
      );
    },

    /** Explicit counts report unknown membership; uncounted pages defer this scan. */
    async unresolvedCount<Filters extends object>(
      db: Database | DrizzleTransaction,
      filters: Filters,
      context: ListContext = ListContext.empty,
    ): Promise<number | undefined> {
      if (!scaffold.hasResultFilters(filters)) return undefined;
      return countWhere(
        db,
        table,
        scaffold.unresolvedWhere(filters, context),
        listTable,
      );
    },

    /** One snapshot per page; refuse any population change during cursor traversal. */
    async selectionIds(
      db: Database | DrizzleTransaction,
      filters: ListFilterValues,
      input: { cursor?: string; limit: number },
    ) {
      const cursor =
        input.cursor === undefined
          ? null
          : selectionCursorSchema.parse(JSON.parse(input.cursor));
      const context = await scaffold.context(db, {
        filters,
        readIntent: "count",
      });
      const filtered = scaffold.where(filters, { context });
      const nesting = listNestingFromFilters(filters);
      const parent = nesting.scope === "flat" ? null : treeParent();
      const where =
        nesting.scope === "flat" || !parent
          ? filtered
          : and(filtered, nestingCondition(nesting, parent, filtered));
      const matches = unwrapDb(db)
        .selectDistinct({ id: sql<string>`${table.shortcode}` })
        .from(listTable)
        .where(where);
      const relation = sql`(
        WITH matches(code) AS MATERIALIZED (${matches}), population AS (
          SELECT count(*)::int AS count, md5(coalesce(jsonb_agg(code ORDER BY code)::text, '[]')) AS fingerprint FROM matches
        ), page AS (
          SELECT code FROM matches ${cursor === null ? sql`` : sql`WHERE code > ${cursor.after}`} ORDER BY code LIMIT ${input.limit + 1}
        ) SELECT jsonb_build_object('ids', coalesce((SELECT jsonb_agg(code ORDER BY code) FROM page), '[]'::jsonb), 'totalCount', population.count, 'fingerprint', population.fingerprint) AS payload FROM population
      ) selection_page`;
      const [row] = await unwrapDb(db)
        .select({ payload: sql<unknown>`selection_page.payload` })
        .from(relation);
      const page = selectionPageSchema.parse(row?.payload);
      if (cursor !== null && cursor.fingerprint !== page.fingerprint)
        throw createAppError(
          "CONSTRAINT_VIOLATION",
          `${entity} selection population changed while collecting IDs; restart selection`,
        );
      const ids = page.ids.slice(0, input.limit);
      const after = ids.at(-1);
      return {
        ids,
        totalCount: page.totalCount,
        nextCursor:
          page.ids.length > input.limit && after !== undefined
            ? JSON.stringify({ after, fingerprint: page.fingerprint })
            : null,
      };
    },

    /** Compile every dimension, joining explicit expansions under stable aliases. */
    group<Filters extends object>(
      filters: Filters,
      context: ListContext = ListContext.empty,
    ): ListGroupSql[] {
      return listGroupByFromFilters(filters).map((dimension, index) => {
        const group = groupSql(entity, dimension, derivedSql, table, context);
        if (!group.members) return group;
        const at = (column: string) =>
          sql`${sql.identifier(`list_group_${index}`)}.${sql.identifier(column)}`;
        const value = group.choice.value;
        const options =
          value !== null && "options" in value ? value.options : null;
        const order: ListGroupSql["order"] =
          value?.kind === "record"
            ? ["label", "key"]
            : options?.length
              ? [
                  sql`array_position(ARRAY[${sql.join(
                    options.map((option) => sql`${option.value}`),
                    sql`, `,
                  )}]::text[], ${at("key")})`,
                  "key",
                ]
              : ["key"];
        return {
          ...group,
          key: at("key"),
          label: at("label"),
          subtree: at("subtree"),
          order,
        };
      });
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
          // Declared tie-breakers finish on the primary key; otherwise the
          // public shortcode orders ties independently of insertion order.
          tieBreaker: opts?.tieBreaker
            ? sql`${opts.tieBreaker}, ${table.id} asc`
            : sql`${table.shortcode} asc`,
        },
      );
    },

    page(pagination: PaginationParams): { take: number; skip: number } {
      return buildTakeSkip(pagination);
    },

    /**
     * One declared filter's facet over the filtered set minus that filter's
     * own request keys, so its alternatives stay meaningful: per-value counts
     * for a stored enum, boolean, presence or flat reference filter, min/max
     * for a scalar range. Compound, predicate, `anyOf` and hierarchical
     * reference filters have no facet (null). Missing results are counted
     * separately from known empty values.
     */
    async countBy(
      db: Database | DrizzleTransaction,
      filters: ListFilterValues,
      descriptorId: string,
    ): Promise<ListFacet | null> {
      const descriptor = descriptorsFor(entity).find(
        (candidate) => candidate.columnId === descriptorId,
      );
      const [columnKey] = descriptor?.stored?.columns ?? [];
      if (!descriptor || descriptor.anyOf !== null) return null;
      const derived = descriptor.derived
        ? derivedFields[descriptor.derived]
        : undefined;
      if (
        derived &&
        (derived.shape !== "value" || derived.type === "dateInterval")
      )
        return null;
      if (columnKey === undefined && !derived) return null;
      const own = new Set([
        descriptor.field ?? descriptor.columnId,
        ...descriptorValueKeys(descriptor),
      ]);
      const rest = Object.fromEntries(
        Object.entries(listFilterValues.parse(filters)).filter(
          ([key]) => !own.has(key),
        ),
      );
      const base =
        columnKey === undefined
          ? undefined
          : storedColumn(entity, table, descriptor, columnKey);
      const model = fieldModel?.fields.find(
        (field) => field.key === descriptor.derived,
      );
      // Picking a hierarchy node matches its descendants too; a direct count
      // would show a parent with child-only rows as 0.
      if (
        descriptor.kind === "idMulti" &&
        isHierarchyEntity(String(base?.reference ?? model?.reference?.entity))
      )
        return null;
      const context = await scaffold.context(
        db,
        {
          filters: rest,
          sorts: descriptor.derived
            ? [{ orderBy: descriptor.derived, direction: "asc" }]
            : [],
        },
        [],
        { projection: false },
      );
      const available = descriptorAvailabilitySql(entity, table, descriptor, {
        derived: derivedSql,
        rows: rowsSql,
        context,
      });
      const certain = scaffold.where(rest, { context, membership: "certain" });
      const where = and(certain, available ?? undefined);
      const hasUnknown = available !== null || scaffold.hasResultFilters(rest);
      const unresolvedCount = hasUnknown
        ? await countWhere(
            db,
            table,
            and(
              scaffold.where(rest, { context, membership: "possible" }),
              sql`(${and(certain, available ?? undefined) ?? sql`true`}) IS NOT TRUE`,
            ),
            listTable,
          )
        : undefined;
      const value = descriptor.derived
        ? derivedValueSql(entity, derivedSql, descriptor.derived, context)
        : base?.value;
      if (!value) return null;
      const stored = {
        value,
        kind:
          derived?.shape === "value" ? derived.type : (base?.kind ?? "text"),
        reference: model?.reference?.entity ?? base?.reference ?? null,
      };
      if (descriptor.kind === "range") {
        const bound = (aggregate: "min" | "max") =>
          stored.kind === "timestamp"
            ? sql<string | null>`${sql.raw(aggregate)}(${value})::date::text`
            : sql<string | null>`${sql.raw(aggregate)}(${value})::text`;
        const [row] = await unwrapDb(db)
          .select({ min: bound("min"), max: bound("max") })
          .from(listTable)
          .where(where);
        return {
          id: descriptorId,
          kind: "range",
          min: row?.min ?? null,
          max: row?.max ?? null,
          ...(unresolvedCount === undefined ? {} : { unresolvedCount }),
        };
      }
      const keyed = facetValueSql(entity, descriptor, stored);
      if (keyed === null) return null;
      const rows = await unwrapDb(db)
        .select({
          value: sql<string | null>`(${keyed})::text`,
          count: sql<number>`count(*)::int`,
        })
        .from(listTable)
        .where(where)
        .groupBy(sql`1`);
      return {
        id: descriptorId,
        kind: "values",
        ...(unresolvedCount === undefined ? {} : { unresolvedCount }),
        options: rows.flatMap(({ value: key, count }) =>
          key !== null
            ? [{ value: key, count }]
            : descriptor.nullable
              ? [{ value: FILTER_NONE, count }]
              : [],
        ),
      };
    },

    /**
     * The entity's page through its declared read. A caller may supply the
     * prepared context or WHERE it already built for the same request.
     */
    async read<Filters extends object>(
      db: Database | DrizzleTransaction,
      request: ListRequest<Filters>,
      override: Pick<
        ListHydration<Row, ListReadRow>,
        "context" | "where" | "count" | "joins" | "orderBy"
      > = {},
    ) {
      const plan = readPlan();
      const projection = request.projection ?? plan.fields.list;
      plan.validate(projection);
      const scoped = { ...request, projection };
      // Prepared derived values a projection reads render into its select.
      const context = (
        override.context ?? (await scaffold.context(db, scoped))
      ).withReader(request.reader);
      const totals =
        request.readIntent !== "count" && request.projection === undefined
          ? scaffold.totalSummary(db, request.filters, context)
          : undefined;
      const [page, summary] = await Promise.all([
        scaffold.list(db, scoped, {
          orderBy: readDeclaration.orderBy?.(
            listFilterValues.parse(request.filters),
          ),
          ...override,
          context,
          tieBreaker: readDeclaration.tieBreaker,
          ...readRows(db, context),
          derived: true,
          hydrate: (rows, selected, hydration, prefetched) =>
            plan.read(db, rows, selected, hydration, "stored", prefetched),
          prefetch: (ids, selected) =>
            plan.prefetch(db, ids, selected, "stored", "list", context),
        }),
        totals,
      ]);
      return summary === undefined ? page : { ...page, ...summary };
    },

    /**
     * Live records by public code through the same declared read, with the
     * detail projection by default: no filter compilation, ordering or
     * count. Absent, foreign and deleted codes are simply missing. Quality
     * evaluates live, as every record read does.
     */
    async get(
      db: Database | DrizzleTransaction,
      codes: readonly string[],
      projection: ListProjection = readPlan().fields.detail,
      reader?: ListReader,
    ): Promise<{ data: ListReadRow[]; fieldReads?: PageFieldReadContexts }> {
      if (codes.length === 0) return { data: [] };
      const plan = readPlan();
      plan.validate(projection);
      const context = (
        await scaffold.context(db, {
          filters: { ids: [...codes] },
          projection,
        })
      ).withReader(reader);
      const where = and(
        notDeleted(table),
        shortcodeSetCondition(sql`${table.shortcode}`, [...codes]),
      );
      if (where === undefined) throw new Error("A read needs a WHERE");
      const selection = readRows(db, context);
      const rows = selection.load
        ? await selection.load(where, projection)
        : await selection.select(
            { where, orderBy: [], limit: codes.length, offset: 0 },
            projection,
          );
      if (rows.length === 0) return { data: [] };
      return withPageFields(db, entity, rows, () =>
        plan.read(db, rows, projection, context, "live", undefined, "detail"),
      );
    },

    /** {@link get} by internal ids, for writers that hold the row they wrote. */
    async getByIds(
      db: Database | DrizzleTransaction,
      ids: readonly string[],
      projection?: ListProjection,
      reader?: ListReader,
    ) {
      if (ids.length === 0) return { data: [] };
      const codes = await unwrapDb(db)
        .select({
          id: sql<string>`${table.id}`,
          code: sql<string>`${table.shortcode}`,
        })
        .from(listTable)
        .where(and(inArray(table.id, [...ids]), notDeleted(table)));
      const read = await scaffold.get(
        db,
        codes.map((row) => row.code),
        projection,
        reader,
      );
      // Rows come back keyed by public id; restore the requested id order.
      const byCode = new Map(
        read.data.map((row) => {
          const { id } = listRowIdSchema.parse(row);
          return [parseShortcode(id)?.shortcode ?? id, row] as const;
        }),
      );
      const codeOf = new Map(codes.map((row) => [row.id, row.code]));
      return {
        ...read,
        data: ids.flatMap((id) => {
          const code = codeOf.get(id);
          const row = code === undefined ? undefined : byCode.get(code);
          return row === undefined ? [] : [row];
        }),
      };
    },

    /** Numeric consumers receive only totals whose contributions are complete. */
    async totals<Filters extends object>(
      db: Database | DrizzleTransaction,
      filters: Filters,
      context?: ListContext,
    ): Promise<Record<string, number> | undefined> {
      const totals = await scaffold.totalSummary(db, filters, context);
      return totals === undefined
        ? undefined
        : Object.fromEntries(
            Object.entries(totals.sums).filter(
              ([key]) => !totals.incompleteSums.includes(key),
            ),
          );
    },

    /** Sums and publication completeness share the existing aggregate statement. */
    async totalSummary<Filters extends object>(
      db: Database | DrizzleTransaction,
      filters: Filters,
      context?: ListContext,
    ): Promise<
      { sums: Record<string, number>; incompleteSums: string[] } | undefined
    > {
      const totals = entitySummary[entity]?.list.totals ?? [];
      const keys = [...new Set(totals.flatMap((total) => total.keys))];
      if (keys.length === 0) return undefined;
      const prepared =
        context ??
        (await scaffold.context(db, {
          filters,
          readIntent: "count",
          projection: keys,
        }));
      const where = scaffold.where(filters, { context: prepared });
      const unresolved = scaffold.hasResultFilters(filters)
        ? scaffold.unresolvedWhere(filters, prepared)
        : undefined;
      const selections: Record<string, SQL<number | boolean>> = {};
      for (const [index, key] of keys.entries())
        selections[`sum_${index}`] =
          sql<number>`COALESCE(sum((${listMetricSql(entity, key, derivedSql, table, prepared)})::numeric) FILTER (WHERE ${where ?? sql`true`}), 0)::double precision`;
      if (unresolved)
        selections.unresolved = sql<boolean>`COALESCE(bool_or(${unresolved}), false)`;
      for (const [index, total] of totals.entries()) {
        if (!("requiresResults" in total)) continue;
        const results = (total.requiresResults ?? []).map((key) => {
          const field = derivedFields[key];
          const currentValue =
            field?.shape === "value" && field.type === "number"
              ? derivedValueSql(entity, derivedSql, key, prepared)
              : undefined;
          const available = storedFieldAvailableSql(entity, key, table.id, {
            currentValue,
          });
          if (!available)
            throw new Error(
              `${entity}.totals.${total.id}: ${key} is not a published result`,
            );
          return available;
        });
        const live = total.keys.flatMap((key) => {
          const field = derivedFields[key];
          return field?.shape === "value" && field.type === "number"
            ? [derivedValueSql(entity, derivedSql, key, prepared)]
            : [];
        });
        // Current authoritative scalars can settle a contribution before publication.
        const ready = or(
          and(...results),
          live.length === total.keys.length
            ? and(...live.map((value) => sql`${value} IS NOT NULL`))
            : undefined,
        );
        selections[`incomplete_${index}`] =
          sql<boolean>`COALESCE(bool_or((${ready}) IS NOT TRUE) FILTER (WHERE ${where ?? sql`true`}), false)`;
      }
      const [row] = await unwrapDb(db)
        .select(selections)
        .from(listTable)
        // Unknown candidates establish completeness but never enter the known subtotal.
        .where(unresolved ? or(where ?? sql`true`, unresolved) : where);
      const flags = z
        .record(z.string(), z.union([z.number(), z.boolean()]))
        .parse(row);
      return {
        sums: Object.fromEntries(
          keys.map((key, index) => [key, Number(flags[`sum_${index}`])]),
        ),
        incompleteSums:
          flags.unresolved === true
            ? keys
            : [
                ...new Set(
                  totals.flatMap((total, index) =>
                    flags[`incomplete_${index}`] === true ? total.keys : [],
                  ),
                ),
              ],
      };
    },

    /** Narrow/internal consumers retain the selected raw shape and own their explicit computation. */
    async raw<Filters extends object, Raw = InferSelectModel<T>>(
      db: Database | DrizzleTransaction,
      request: ListRequest<Filters>,
      spec: Omit<ListHydration<Raw, Raw>, "hydrate"> & ListSelection<Raw>,
    ) {
      if (request.projection && listEntity)
        selectedListProjection(listEntity, request.projection);
      return scaffold.list(
        db,
        { ...request, projection: request.projection ?? [] },
        { ...spec, hydrate: (rows) => rows },
      );
    },
    /**
     * One list read: where → order → page → rows → hydrate. A
     * `count` read never runs the row query or hydration.
     */
    async list<Filters extends object, Out, Row = InferSelectModel<T>>(
      db: Database | DrizzleTransaction,
      request: ListRequest<Filters>,
      spec: ListSpec<Row, Out>,
    ): Promise<{
      data: Out[];
      fieldReads?: PageFieldReadContexts;
      count?: number;
      hasNextPage: boolean;
      unresolvedCount?: number;
      incompleteSums?: string[];
      groups?: ListGroupSummary[];
      memberships?: ListGroupMembership[];
      membershipCount?: number;
    }> {
      // Keep the PgTable object: interpolating an aliased table into SQL
      // emits only its alias, while Drizzle's FROM builder names its origin.
      const source = listTable;
      // The query reads only filter, sort and grouping prepares. Prepares a page
      // merely displays load beside the id and row queries, for hydration.
      const context =
        spec.context ??
        (await scaffold.context(db, request, [], { projection: false }));
      const hydrationContext =
        spec.context || request.readIntent === "count"
          ? Promise.resolve(spec.context ?? context)
          : scaffold
              .context(db, request, context.entries(), { nested: false })
              .then((full) => context.with(full));
      hydrationContext.catch(() => {
        // SILENT: hydration awaits and surfaces this rejection; only a page
        // that fails or returns no rows first leaves it unread.
      });
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
      const projection = request.projection ?? pageFields();
      const { take, skip } = buildTakeSkip(request.pagination);
      const readIntent = request.readIntent ?? "page";
      const includeCount =
        request.includeCount !== false || readIntent === "count";
      // Sections lead the total order, so a page never splits a section the
      // summary query counts whole.
      const group =
        readIntent === "count" ? [] : scaffold.group(request.filters, context);
      if (group.length && spec.count && !spec.joins)
        throw new Error(
          `${entity} counts its own FROM; pass its joins to group the list`,
        );
      const page: ListPage = {
        where,
        // A count never orders, and skipped the prepares a derived sort reads.
        orderBy:
          readIntent === "count"
            ? []
            : [
                ...group.flatMap(groupOrderBy),
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
            // Keep Drizzle's root table and column decoders.
            // SAFETY: T extends PgTable; erase only the generic FROM constraint.
            const root: PgTable = table;
            // SAFETY: selecting only the root table's columns preserves Row,
            // including its Drizzle decoders.
            return (await unwrapDb(db)
              .select(getTableColumns(root))
              .from(root)
              .where(clauses.where)
              .orderBy(...clauses.orderBy)
              .limit(clauses.limit)
              .offset(clauses.offset)) as Row[];
          }));
      let prefetched: ListPagePrefetch | undefined;
      let storedMeta: Promise<PageStoredMeta> | undefined;
      let currentOwnership:
        | ReturnType<typeof loadCurrentFieldOwnership>
        | undefined;
      // The id/count projection binds no fields, so it carries no envelope.
      const withEnvelope = Boolean(spec.derived) && projection.length > 0;
      const readLoadedPage =
        loadIds && !spec.count
          ? () =>
              traceListPageWithCount(async (span) => {
                // Uncounted pages select only a bounded id page. The lookahead id
                // establishes continuation and never reaches hydration or bindings.
                const ids = await unwrapDb(db)
                  .select({
                    id: sql<string>`${table.id}`,
                    ...(includeCount
                      ? { total: sql<number>`count(*) OVER ()::int` }
                      : {}),
                  })
                  .from(source)
                  .where(page.where)
                  .orderBy(...page.orderBy)
                  .limit(page.limit + (includeCount ? 0 : 1))
                  .offset(page.offset);
                // With a positive LIMIT, an empty first page proves the total is zero.
                // Later empty pages need a count because OFFSET may hide matches.
                const count = includeCount
                  ? (ids[0]?.total ??
                    (page.offset === 0 && page.limit > 0
                      ? 0
                      : await countWhere(db, table, where, source)))
                  : undefined;
                const hasNextPage =
                  count === undefined
                    ? ids.length > page.limit
                    : page.offset + page.limit < count;
                const pageIds = ids.slice(0, page.limit).map((row) => row.id);
                prefetched = spec.prefetch?.(pageIds, projection);
                // The envelope's stored meta needs only ids: read it beside the rows.
                storedMeta = withEnvelope
                  ? loadPageStoredMeta(db, entity, pageIds)
                  : undefined;
                // Awaited after hydration; this only keeps an early failure handled.
                storedMeta?.catch(() => undefined);
                currentOwnership = withEnvelope
                  ? loadCurrentFieldOwnership(db, entity, pageIds)
                  : undefined;
                currentOwnership?.catch(() => undefined);
                const data = await loadIds(pageIds, projection);
                span.setAttributes({
                  "db.result_count": data.length,
                  ...(count === undefined ? {} : { "db.total_count": count }),
                  "list.rows": data.length,
                });
                return { data, count, hasNextPage };
              })
          : undefined;
      return withListReadTracing(
        { entity, fields: projection.length },
        async () => {
          const groupedPage =
            group.length && readIntent === "page"
              ? await readGroupedQuery({
                  db,
                  source,
                  id: sql`${table.id}`,
                  code: sql`${table.shortcode}`,
                  where,
                  joins: spec.joins,
                  groups: group,
                  metrics: generatedEntityListFields[entity].metrics.map(
                    ({ key }) => ({
                      key,
                      value: listMetricSql(
                        entity,
                        key,
                        derivedSql,
                        table,
                        context,
                      ),
                    }),
                  ),
                  order: page.orderBy,
                  limit: take,
                  offset: skip,
                })
              : null;
          const result = groupedPage
            ? {
                count: groupedPage.count,
                hasNextPage: skip + take < groupedPage.membershipCount,
                data:
                  groupedPage.ids.length === 0
                    ? []
                    : await selectRows(
                        {
                          ...page,
                          where: and(where, inArray(table.id, groupedPage.ids)),
                          orderBy: [],
                          limit: groupedPage.ids.length,
                          offset: 0,
                        },
                        projection,
                      ).then((rows) => {
                        const keyed = new Map(
                          rows.map((row) => [
                            listRowIdSchema.parse(row).id,
                            row,
                          ]),
                        );
                        return groupedPage.ids.flatMap((id) => {
                          const row = keyed.get(id);
                          return row === undefined ? [] : [row];
                        });
                      }),
              }
            : readIntent !== "count" && readLoadedPage
              ? await readLoadedPage()
              : !includeCount
                ? await executeListQueryWithoutCount({
                    rows: () =>
                      selectRows({ ...page, limit: take + 1 }, projection),
                    pageSize: take,
                  })
                : await executeListQueryWithCount({
                    kind: readIntent,
                    rows: () => selectRows(page, projection),
                    count:
                      spec.count ??
                      (() => countWhere(db, table, where, source)),
                  });
          const { data, count } = result;
          const hasNextPage =
            "hasNextPage" in result
              ? result.hasNextPage
              : count !== undefined && skip + take < count;
          const grouped =
            groupedPage === null
              ? {}
              : {
                  groups: groupedPage.groups,
                  memberships: groupedPage.memberships,
                  membershipCount: groupedPage.membershipCount,
                };
          const unresolvedCount = includeCount
            ? await scaffold.unresolvedCount(db, request.filters, context)
            : undefined;
          if (readIntent === "count" || data.length === 0)
            return {
              data: [],
              count,
              hasNextPage,
              unresolvedCount,
              ...grouped,
            };
          return withListReadTracing({ rows: data.length }, async () => {
            const context = await hydrationContext;
            if (withEnvelope) {
              const ids = data.map((row) => listRowIdSchema.parse(row).id);
              storedMeta ??= loadPageStoredMeta(db, entity, ids);
              storedMeta.catch(() => {
                // SILENT: withPageFields awaits this same promise and surfaces its failure.
              });
              prefetched ??= spec.prefetch?.(ids, projection);
              if (prefetched) prefetched.page.stored = storedMeta;
            }
            const hydrate = () =>
              spec.hydrate(data, projection, context, prefetched);
            const complete = withEnvelope
              ? await withPageFields(
                  db,
                  entity,
                  data,
                  hydrate,
                  storedMeta,
                  currentOwnership,
                )
              : { data: await hydrate(), fieldReads: undefined };
            const hydrated = complete.data;
            if (!parent)
              return {
                ...complete,
                count,
                hasNextPage,
                unresolvedCount,
                ...grouped,
              };
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
              fieldReads: complete.fieldReads,
              count,
              hasNextPage,
              unresolvedCount,
              ...grouped,
            };
          });
        },
      );
    },
  };
  const { list: _executeList, ...publicScaffold } = scaffold;
  const result = {
    ...publicScaffold,
    evidence: readDeclaration.evidence,
    optionCount(): SQL | undefined {
      const key = readDeclaration.optionCount;
      return key ? declaredRollup(entity, key, table) : undefined;
    },
    optionKind: readDeclaration.optionKind,
    search: readDeclaration.search,
    title(): SQL | undefined {
      if (readDeclaration.title) return sql`(${readDeclaration.title})::text`;
      const title = fieldModel?.fields.find(
        (field) => field.readKey === entitySummary[entity].titleField,
      );
      const stored = fieldModel?.storage.find(
        (field) => field.key === title?.key,
      );
      const column = tableColumns.find(
        (entry) => entry.name === stored?.column,
      );
      return column ? sql`(${column})::text` : undefined;
    },
    /** The keys a page and a single-record read load by default. */
    get fields() {
      return readPlan().fields;
    },
  };
  // Query-only and aliased scaffolds do not own an entity's public read ports.
  if (options?.read && getTableName(table) === entityManifest[entity].dbTable)
    registerReadPorts(entity, {
      title: result.title,
      fieldReads: async (db, codes) => {
        // SAFETY: the query boundary erases the schema, not the native handle.
        const readDb = db as Database | DrizzleTransaction;
        return (await result.get(readDb, codes, [])).fieldReads;
      },
    });
  return result;
}

/** Any entity's scaffold, as the kernel and generic modules receive it. */
export type EntityListScaffold = ReturnType<
  typeof listScaffold<SortableEntity, ListScaffoldTable, never>
>;
type ListScaffoldTable = PgTable & {
  id: AnyColumn;
  deletedAt?: AnyColumn;
  createdAt: AnyColumn;
  updatedAt: AnyColumn;
  shortcode: AnyColumn;
};

/**
 * The key a row contributes to a value facet, as the filter value a pick
 * sends: the enum value, `true`/`false`, `has`/`none`, or the referenced
 * row's public shortcode (NULL is No value, a dangling or soft-deleted
 * reference included). A text array contributes each element.
 */
const PRESENCE = presenceFilter.unwrap().enum;

const facetValueSql = (
  entity: Entity,
  descriptor: DeclaredFilterDescriptor,
  {
    value,
    kind,
    reference,
  }: Pick<FilterColumn, "value" | "kind" | "reference">,
): SQL | null => {
  switch (descriptor.kind) {
    case "boolean":
      return kind === "boolean" ? sql`${value}` : sql`(${value}) IS NOT NULL`;
    case "presence":
      return kind === "boolean"
        ? sql`CASE WHEN (${value}) THEN ${PRESENCE.has}::text ELSE ${PRESENCE.none}::text END`
        : sql`CASE WHEN (${value}) IS NULL THEN ${PRESENCE.none}::text ELSE ${PRESENCE.has}::text END`;
    case "multiselect":
      return descriptor.stored?.array ? sql`unnest(${value})` : sql`${value}`;
    case "idMulti": {
      const target = Object.keys(SHORTCODE_TABLE).find(
        (key): key is ShortcodeEntity => key === reference,
      );
      const dbTable = target ? entityManifest[target].dbTable : null;
      if (!target || dbTable === null)
        throw new Error(
          `${entity}.${descriptor.columnId} references ${String(reference)}, which has no shortcode table`,
        );
      return sql`(SELECT ref."shortcode" FROM ${sql.identifier(dbTable)} ref WHERE ref."id" = ${value}${
        entityManifest[target].softDelete
          ? sql` AND ${notDeleted("ref")}`
          : sql``
      })`;
    }
    default:
      return null;
  }
};
