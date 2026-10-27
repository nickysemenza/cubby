import { z } from "zod";

import type { FilterKind } from "./entity-definitions/definition";
import {
  excludableFilterKind,
  filterExcludeField,
} from "./filter-sentinel-fields";
import type { ShortcodeEntity } from "./entity-manifest";
import type { GeneratedGroupChoice } from "./generated/entity-list-fields.gen";
import { nonEmptyTuple } from "./identifier-fields";
import {
  normalizeSorts,
  oneOrMany,
  presenceFilter,
  sortDirection,
} from "./pagination";

/**
 * A declared list over a relation: rows projected from SQL (the Work queue's
 * work sources, a Suggestion family) rather than read from one entity table.
 * It declares its filters, sorts, Group by choices and saved views once;
 * the URL codec, the server predicate compiler and the read's input schema
 * all derive from it, as they do from an entity declaration.
 */

type Options = readonly { readonly value: string; readonly label: string }[];

/** A filter over one relation column. */
export interface RelationFilter {
  readonly columnId: string;
  readonly label: string;
  readonly kind: Extract<
    FilterKind,
    "text" | "multiselect" | "idMulti" | "boolean" | "range"
  >;
  /** The relation column; defaults to `columnId`. */
  readonly column?: string;
  /** A `text[]` column: picks overlap, Match all requires every pick. */
  readonly array?: boolean;
  /** Values are this entity's shortcodes; its roster feeds the options. */
  readonly reference?: ShortcodeEntity;
  /** Offers `@me`, which the operation runtime resolves (ADR 0018). */
  readonly currentMember?: boolean;
  /** Adds Any value / No value, written to `${columnId}Presence`. */
  readonly nullable?: { readonly label: string };
  readonly options?: Options;
  readonly range?: "number" | "date";
}

export interface RelationSort {
  readonly key: string;
  readonly label: string;
  readonly column?: string;
}

/** A named filter set the list counts and offers as a tab (ADR 0022). */
export interface RelationView<K extends string = string> {
  readonly key: K;
  readonly label: string;
  readonly filters: Readonly<Record<string, string | readonly string[]>>;
}

type SupportedChoice<K extends string> = GeneratedGroupChoice & {
  readonly key: K;
  readonly reason: null;
};
type UnsupportedChoice<K extends string> = GeneratedGroupChoice & {
  readonly key: K;
  readonly reason: string;
};

/**
 * A flat section over a relation column. `filter` names the declared filter
 * a section's key selects ("Filter to this"); `noValue` means that filter
 * also selects the no-value section.
 */
export const relationGroupChoice = <const K extends string>(choice: {
  key: K;
  label: string;
  column?: string;
  noValueLabel?: string;
  filter: { columnId: string; noValue: boolean } | null;
  options?: Options;
}): SupportedChoice<K> => ({
  key: choice.key,
  label: choice.label,
  noValueLabel: choice.noValueLabel ?? "None",
  reason: null,
  value: {
    kind: "column",
    column: choice.column ?? choice.key,
    options: choice.options ?? [],
  },
  filter: choice.filter && { ...choice.filter, subtree: null },
  levels: 0,
  levelReason: `${choice.label} is a flat section, not a hierarchy.`,
  multiple: false,
  dateKind: null,
  buckets: [],
});

/** A field the list cannot section by, with the reason a menu states. */
export const unsupportedGroupChoice = <const K extends string>(choice: {
  key: K;
  label: string;
  reason: string;
}): UnsupportedChoice<K> => ({
  key: choice.key,
  label: choice.label,
  noValueLabel: "None",
  reason: choice.reason,
  value: null,
  filter: null,
  levels: 0,
  levelReason: choice.reason,
  multiple: false,
  dateKind: null,
  buckets: [],
});

/** The serializable part of the web codec's `FilterSpecCore`. */
export interface RelationFilterSpec {
  readonly columnId: string;
  readonly kind: FilterKind;
  readonly referenceEntity?: ShortcodeEntity;
  readonly currentMember?: boolean;
  readonly nullable?: { readonly field: string; readonly label: string };
  readonly exclude?: { readonly field: string };
  readonly range?: { readonly from: string; readonly to: string };
}

/** The server compiler's descriptor (`DeclaredFilterDescriptor`). */
export interface RelationFilterDescriptor {
  readonly columnId: string;
  readonly field: string | null;
  readonly kind: string;
  readonly stored: { readonly columns: readonly string[]; array: boolean };
  readonly anyOf: null;
  readonly nullable: { readonly field: string } | null;
  readonly match: null;
  readonly exclude: { readonly field: string } | null;
  readonly range: { readonly kind: "number" | "date" } | null;
  readonly derived: null;
  readonly wire:
    | { readonly kind: "param"; readonly name: string }
    | { readonly kind: "range"; readonly from: string; readonly to: string };
}

const rangeKeys = (columnId: string) => ({
  from: `${columnId}From`,
  to: `${columnId}To`,
});
const presenceField = (columnId: string) => `${columnId}Presence`;

const specOf = (filter: RelationFilter): RelationFilterSpec => ({
  columnId: filter.columnId,
  kind: filter.kind,
  ...(filter.reference ? { referenceEntity: filter.reference } : {}),
  ...(filter.currentMember ? { currentMember: true } : {}),
  ...(filter.nullable
    ? {
        nullable: {
          field: presenceField(filter.columnId),
          label: filter.nullable.label,
        },
      }
    : {}),
  ...(excludableFilterKind(filter.kind)
    ? { exclude: { field: filterExcludeField(filter.columnId) } }
    : {}),
  ...(filter.kind === "range" ? { range: rangeKeys(filter.columnId) } : {}),
});

const descriptorOf = (filter: RelationFilter): RelationFilterDescriptor => ({
  columnId: filter.columnId,
  field: null,
  kind: filter.kind,
  stored: {
    columns: [filter.column ?? filter.columnId],
    array: filter.array ?? false,
  },
  anyOf: null,
  nullable: filter.nullable
    ? { field: presenceField(filter.columnId) }
    : null,
  match: null,
  exclude: excludableFilterKind(filter.kind)
    ? { field: filterExcludeField(filter.columnId) }
    : null,
  range: filter.range ? { kind: filter.range } : null,
  derived: null,
  wire:
    filter.kind === "range"
      ? { kind: "range", ...rangeKeys(filter.columnId) }
      : { kind: "param", name: filter.columnId },
});

const textList = z.string().min(1).max(200);

/** The input keys one filter accepts, by its kind. */
const inputFieldsOf = (filter: RelationFilter): Record<string, z.ZodType> => {
  const describe = (schema: z.ZodType, text: string) =>
    schema.describe(`${filter.label}: ${text}`);
  switch (filter.kind) {
    case "text":
      return {
        [filter.columnId]: describe(
          z.string().max(500).optional(),
          "contains",
        ),
      };
    case "boolean":
      return {
        [filter.columnId]: describe(z.boolean().optional(), "is true/false"),
      };
    case "range": {
      const { from, to } = rangeKeys(filter.columnId);
      const bound =
        filter.range === "date" ? z.string().max(40) : z.number();
      return {
        [from]: describe(bound.optional(), "at least"),
        [to]: describe(bound.optional(), "at most"),
      };
    }
    default: {
      const values = filter.options?.length
        ? z.enum(
            nonEmptyTuple(filter.options.map((option) => option.value)),
          )
        : textList;
      return {
        [filter.columnId]: describe(
          oneOrMany(values).optional(),
          "any of" + (filter.currentMember ? " (`@me` is you)" : ""),
        ),
        [filterExcludeField(filter.columnId)]: describe(
          oneOrMany(values).optional(),
          "none of; rows with no value stay",
        ),
        ...(filter.nullable
          ? {
              [presenceField(filter.columnId)]: describe(
                presenceFilter,
                `has/none ${filter.nullable.label}, ORed with picks`,
              ),
            }
          : {}),
      };
    }
  }
};

export interface RelationListDeclaration<
  C extends GeneratedGroupChoice = GeneratedGroupChoice,
  V extends string = string,
> {
  readonly filters: readonly RelationFilter[];
  readonly sorts: readonly [RelationSort, ...RelationSort[]];
  readonly defaultSort: { orderBy: string; direction: "asc" | "desc" };
  readonly grouping: readonly C[];
  readonly views: readonly RelationView<V>[];
  readonly pageSize: { default: number; max: number };
}

/** Checks the declaration at module load and derives its codec, compiler
 * descriptors and input schema. */
export function defineRelationList<
  const C extends SupportedChoice<string> | UnsupportedChoice<string>,
  const V extends string,
>(list: RelationListDeclaration<C, V>) {
  const columnIds = new Set(list.filters.map((filter) => filter.columnId));
  for (const choice of list.grouping) {
    const columnId = choice.filter?.columnId;
    if (columnId && !columnIds.has(columnId))
      throw new Error(
        `Group by ${choice.key} filters by undeclared column ${columnId}`,
      );
  }
  for (const view of list.views)
    for (const key of Object.keys(view.filters))
      if (
        !list.filters.some((filter) =>
          Object.keys(inputFieldsOf(filter)).includes(key),
        )
      )
        throw new Error(`View ${view.key} sets undeclared filter ${key}`);
  const groupKeys = list.grouping
    .filter((choice): choice is Extract<C, { reason: null }> => !choice.reason)
    .map((choice) => choice.key);
  const sortKeys = nonEmptyTuple(list.sorts.map((sort) => sort.key));
  const viewKeys = list.views.map((view) => view.key);
  const input = z.strictObject({
    pageIndex: z.number().int().min(0).default(0),
    pageSize: z
      .number()
      .int()
      .min(1)
      .max(list.pageSize.max)
      .default(list.pageSize.default),
    query: z.string().max(500).optional().describe("Search text"),
    sort: z
      .array(
        z.object({
          orderBy: z.enum(sortKeys),
          direction: sortDirection.default("asc"),
        }),
      )
      .min(1)
      .max(3)
      .optional(),
    ...(groupKeys.length
      ? { group: z.enum(nonEmptyTuple(groupKeys)).optional() }
      : {}),
    ...(viewKeys.length
      ? { view: z.enum(nonEmptyTuple(viewKeys)).optional() }
      : {}),
    ...Object.assign({}, ...list.filters.map(inputFieldsOf)),
  });
  return {
    ...list,
    specs: list.filters.map(specOf),
    descriptors: list.filters.map(descriptorOf),
    input,
    /** The requested sorts, deduplicated, else the declared default. */
    sortsOf: (sort: readonly { orderBy: string; direction?: string }[] = []) =>
      normalizeSorts(
        (sort.length ? sort : [list.defaultSort]).map((entry) => ({
          orderBy: entry.orderBy,
          direction: entry.direction === "desc" ? "desc" : "asc",
        })),
      ),
  };
}

export type RelationList = ReturnType<typeof defineRelationList>;

/** A filter's static options, for cell labels and pickers. */
export const relationFilterOptions = (
  list: Pick<RelationListDeclaration, "filters">,
  columnId: string,
): Options =>
  list.filters.find((filter) => filter.columnId === columnId)?.options ?? [];
