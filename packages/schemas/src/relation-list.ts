import { z } from "zod";

import type { FilterKind } from "./entity-definitions/definition";
import {
  excludableFilterKind,
  filterExcludeField,
} from "./filter-sentinel-fields";
import type { ShortcodeEntity } from "./entity-manifest";
import type { GeneratedGroupChoice } from "./generated/entity-list-fields.gen";
import { shortcodeSchema } from "./identifier-fields";
import { nonEmptyTuple } from "./identifier-fields";
import {
  entityFilter,
  partyFilter,
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
  readonly range?: {
    readonly from: string;
    readonly to: string;
    readonly number?: {};
  };
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
  ...(filter.kind === "range"
    ? {
        range: {
          ...rangeKeys(filter.columnId),
          ...(filter.range === "number" ? { number: {} } : {}),
        },
      }
    : {}),
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
  nullable: filter.nullable ? { field: presenceField(filter.columnId) } : null,
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
const inputFieldsOf = (filter: RelationFilter) => {
  const describe = (schema: z.ZodType, text: string) =>
    schema.describe(`${filter.label}: ${text}`);
  switch (filter.kind) {
    case "text":
      return {
        [filter.columnId]: describe(z.string().max(500).optional(), "contains"),
      };
    case "boolean":
      return {
        [filter.columnId]: describe(z.boolean().optional(), "is true/false"),
      };
    case "range": {
      const { from, to } = rangeKeys(filter.columnId);
      const bound = filter.range === "date" ? z.string().max(40) : z.number();
      return {
        [from]: describe(bound.optional(), "at least"),
        [to]: describe(bound.optional(), "at most"),
      };
    }
    default: {
      const values = filter.reference
        ? filter.currentMember
          ? partyFilter(shortcodeSchema(filter.reference))
          : entityFilter(shortcodeSchema(filter.reference))
        : filter.options?.length
          ? z.enum(nonEmptyTuple(filter.options.map((option) => option.value)))
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

/** The values a filter accepts: its options' values, else any text. */
type FilterValue<F extends RelationFilter> = F extends {
  readonly options: readonly { readonly value: infer V extends string }[];
}
  ? V
  : string;
type Optional<T> = z.ZodOptional<z.ZodType<T>>;
type UnionToIntersection<U> = (
  U extends unknown ? (union: U) => void : never
) extends (intersection: infer I) => void
  ? I
  : never;

/** The input keys one filter adds, typed by its kind. */
type FilterInputFields<F extends RelationFilter> = F["kind"] extends "text"
  ? { [K in F["columnId"]]: Optional<string> }
  : F["kind"] extends "boolean"
    ? { [K in F["columnId"]]: Optional<boolean> }
    : F["kind"] extends "range"
      ? {
          [K in `${F["columnId"]}From` | `${F["columnId"]}To`]: Optional<
            F["range"] extends "date" ? string : number
          >;
        }
      : {
          [K in F["columnId"] | `${F["columnId"]}Exclude`]: Optional<
            FilterValue<F> | FilterValue<F>[]
          >;
        } & (F extends { readonly nullable: object }
          ? { [K in `${F["columnId"]}Presence`]: typeof presenceFilter }
          : unknown);
type FiltersInputFields<Fs extends readonly RelationFilter[]> =
  UnionToIntersection<{ [I in keyof Fs]: FilterInputFields<Fs[I]> }[number]>;

/** The URL keys one filter writes, by its kind. */
type FilterUrlKeys<F extends RelationFilter> = F extends unknown
  ? F["kind"] extends "range"
    ? `${F["columnId"]}From` | `${F["columnId"]}To`
    : F["kind"] extends "text" | "boolean"
      ? F["columnId"]
      :
          | F["columnId"]
          | `${F["columnId"]}Exclude`
          | (F extends { readonly nullable: object }
              ? `${F["columnId"]}Presence`
              : never)
  : never;
/** Every URL key a declared list's filters write. */
export type RelationListUrlKey<
  L extends { readonly filters: readonly RelationFilter[] },
> = FilterUrlKeys<L["filters"][number]>;

export interface RelationListDeclaration<
  C extends GeneratedGroupChoice = GeneratedGroupChoice,
  V extends string = string,
  Fs extends readonly RelationFilter[] = readonly RelationFilter[],
> {
  readonly filters: Fs;
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
  const Fs extends readonly RelationFilter[],
>(list: RelationListDeclaration<C, V, Fs>) {
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
  // SAFETY: each filter's fields are built by `inputFieldsOf` from the same
  // kind, options and nullability the mapped type reads.
  const filterFields = Object.assign(
    {},
    ...list.filters.map(inputFieldsOf),
  ) as FiltersInputFields<Fs>;
  // Surfaces that compose declared filters at runtime (Suggestions) extend
  // this object with their own scope and paging. Its keys are not known
  // statically, so it types none of them: an index signature would erase the
  // extending fields' own types.
  const runtimeFilterFields: Record<never, z.ZodType> = Object.assign(
    {},
    ...list.filters.map(inputFieldsOf),
  );
  const groupInput = z
    .enum(nonEmptyTuple(groupKeys.length ? groupKeys : ["none"]))
    .optional();
  const input = z.strictObject(
    Object.assign(
      {
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
        group: z
          .enum(nonEmptyTuple(groupKeys.length ? groupKeys : ["none"]))
          .optional(),
        view: z
          .enum(nonEmptyTuple(viewKeys.length ? viewKeys : ["none"]))
          .optional(),
      },
      filterFields,
    ),
  );
  return {
    ...list,
    /** Filter-only schema for surfaces with their own scope and paging. */
    filterInput: z.strictObject(runtimeFilterFields),
    groupInput,
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
