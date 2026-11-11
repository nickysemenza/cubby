import { suggestionStatus } from "@cubby/schemas/ai";
/**
 * The one list module every repository composes: the declared stored-filter
 * predicates (`declaredFilterPredicates`) and the per-entity list scaffold
 * (`listScaffold`) that binds them with the data-quality filters, audit
 * dates, lexical search, the generated sort roster and paging.
 */
import type { Entity } from "@cubby/schemas/entity";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import { generatedEntityListFields } from "@cubby/schemas/entity-list-fields";
import {
  entityInspectorMetadata,
  type ShortcodeEntity,
} from "@cubby/schemas/entity-manifest";
import { presenceFilter, type PresenceFilter } from "@cubby/schemas/pagination";
import {
  type AnyColumn,
  and,
  getTableColumns,
  getTableName,
  or,
  SQL,
  sql,
} from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { z } from "zod";

import {
  effectiveFieldInSql,
  effectiveFieldSql,
  inheritedFieldOfColumn,
} from "~/server/db/computed/effective-field";
import { storedDerived } from "~/server/db/derived-declarations";
import {
  flagCondition,
  formatSearchTerm,
  householdDayRangeConditions,
  notDeleted,
} from "~/server/db/helpers";
import { columnArrayParam } from "~/server/db/helpers/query";
import { SHORTCODE_TABLE } from "~/server/generated/shortcode-tables.gen";
import { storedFieldAvailableSql } from "~/server/generic/derived/repo/read";
import { listTermExpanders } from "~/server/generic/list/repo/terms";

import {
  compileDeclaredFilters,
  type DeclaredFilterDescriptor,
  descriptorValueKeys,
  entitySubtreeToggle,
  type FilterColumn,
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
  shortcodeIdsSql,
  textPredicate,
} from "./declared-filters";
import {
  derivedFieldsOf,
  derivedPredicateSql,
  derivedIntervalSql,
  derivedValueSet,
  derivedValueSql,
  type AnyDerivedSql,
  storedFieldValueSql,
  listFilterValues,
  type ListFilterValues,
  ListContext,
  relatedExistsSql,
  type AnyRowsSql,
  rowSetSql,
} from "./field-compiler";

const suggestionKinds = z
  .union([
    z.enum(["addition", "correction"]),
    z.array(z.enum(["addition", "correction"])),
  ])
  .optional()
  .transform((value) => (value === undefined ? [] : [value].flat()));

export const descriptorsFor = (
  entity: Entity,
): readonly DeclaredFilterDescriptor[] =>
  Object.entries(entityInspectorMetadata).find(([key]) => key === entity)?.[1]
    .filterDescriptors ?? [];
export const fieldModelFor = (
  entity: Entity,
): (typeof entityFieldModels)[Entity] | undefined =>
  Object.entries(entityFieldModels).find(([key]) => key === entity)?.[1];

export const storedColumn = (
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
      stored.specialized === "minor-unit-money"
        ? storedFieldValueSql(entity, `"${getTableName(table)}"`, stored.column)
        : inherited === null
          ? column
          : effectiveFieldSql(entity, inherited, getTableName(table)),
    kind: stored.kind,
    nullable: stored.nullable,
    reference: stored.reference,
  };
};

/** All declared stored scalar forms share the same membership readiness gate. */
export const descriptorResultKey = (
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

export const descriptorAvailabilitySql = (
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
    field?.shape === "value" && field.fromResult && descriptor.derived
      ? descriptor.derived
      : key,
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

/** A generated subtree toggle preserves its filter's declared default. */
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
    : (optionalBoolean.parse(values[toggle.key]) ?? toggle.default);
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
  readonly project?: (value: SQL) => SQL;
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
    if (set === null) {
      const value = derivedValueSql(
        entity,
        derived,
        key,
        input?.context ?? ListContext.empty,
      );
      return condition(input?.project ? input.project(value) : value);
    }
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
    const predicate = derivedPredicateSql(
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
    );
    return [predicate && input?.project ? input.project(predicate) : predicate];
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
        const timestamp = entityFieldModels[entity]?.fields.some(
          (model) => model.key === derivedKey && model.kind === "timestamp",
        );
        return [
          rangeOrPresence(
            // Unbounded reads no value, so an unrequested prepare stays unread.
            low === undefined && high === undefined
              ? undefined
              : test((column) =>
                  timestamp && field.type === "date"
                    ? and(
                        ...householdDayRangeConditions(
                          column,
                          optionalDate.parse(low),
                          optionalDate.parse(high),
                        ),
                      )
                    : and(
                        low === undefined
                          ? undefined
                          : sql`${column} >= ${low}`,
                        high === undefined
                          ? undefined
                          : sql`${column} <= ${high}`,
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
                  (column) => sql`${column} = ANY(${columnArrayParam(list)})`,
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
                )) ?? sql`${column} = ANY(${columnArrayParam(items)})`
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
            ? sql`${column} = ANY(${columnArrayParam(items)})`
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
      ...(toggle === undefined ? [] : [toggle.key]),
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
    SELECT 1 FROM "Suggestion" s
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
      : pending(sql`AND s."kind" = ANY(${columnArrayParam(kinds)})`),
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
      column: (descriptor, key) => {
        const column = storedColumn(entity, table, descriptor, key);
        return derivedInput?.project &&
          descriptorValueKeys(descriptor).some(
            (key) => values[key] !== undefined,
          )
          ? { ...column, value: derivedInput.project(sql`${column.value}`) }
          : column;
      },
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
                const readiness = descriptorAvailabilitySql(
                  entity,
                  table,
                  descriptor,
                  input,
                );
                const available =
                  readiness && input?.project
                    ? input.project(readiness)
                    : readiness;
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
