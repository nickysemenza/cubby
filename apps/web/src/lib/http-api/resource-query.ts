import {
  ENTITY_TIMELINE_DEFAULT_PAGE_SIZE,
  ENTITY_TIMELINE_MAX_PAGE_SIZE,
  entityTimelineWindowFor,
} from "@cubby/schemas/entity-timeline";
import {
  MAX_PAGE_SIZE,
  MAX_SORTS,
  sortPaginationFields,
} from "@cubby/schemas/pagination";
import { z } from "zod";

import {
  type UnparsedStartOperationData,
  unparsedStartOperationDataSchema,
} from "~/server/start-operation.contract";

import { type Json, toWire } from "./wire";

/**
 * The declared list-sort roster an entity's wire controls are narrowed by:
 * the shape of a `generatedEntitySort` entry (`@cubby/schemas/entity-sort`).
 */
export interface ListSortRoster {
  readonly fields: readonly [string, ...string[]];
  readonly default: string;
  readonly groupable: readonly string[];
}

/**
 * The `groupBy` allowlist of a roster. The one place on the wire the kernel
 * rule lives: an empty `groupable` means every sortable field groups
 * (`entity-kernel/adapter.ts` `derivedEntitySort`, `entity-operations.ts`
 * `parseGroupBy`).
 */
export const groupableFieldsOf = (
  roster: ListSortRoster,
): readonly [string, ...string[]] => {
  const [first, ...rest] = roster.groupable;
  return first === undefined ? roster.fields : [first, ...rest];
};

const sortStackPattern = new RegExp(
  `^-?[^,\\s-][^,\\s]*(,-?[^,\\s-][^,\\s]*){0,${MAX_SORTS - 1}}$`,
  "u",
);
const sortDescription = `Comma-separated fields; prefix with - for descending. Maximum ${MAX_SORTS} fields. Example: name,-createdAt`;
const sortFieldOf = (entry: string) =>
  entry.startsWith("-") ? entry.slice(1) : entry;

/**
 * Resource-list controls. They ride alongside the entity's flat filter
 * parameters, so a filter may not reuse one of these names. With a roster,
 * `sort` is checked against the sortable fields (a refinement, which the
 * query projection keeps and the OpenAPI emitter lists in the description)
 * and `groupBy` becomes an enum of the groupable ones; the roster-less
 * controls validate shape only.
 */
const controlsFor = (roster?: ListSortRoster) => {
  // The shape check aborts so a malformed stack reports one issue, not one
  // per fragment.
  const sort = z.string().regex(sortStackPattern, { abort: true });
  return z.object({
    page: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("Page number, starting at 1 (default 1)"),
    pageSize: z
      .number()
      .int()
      .min(1)
      .max(MAX_PAGE_SIZE)
      .optional()
      .describe(
        `Items per page (default ${sortPaginationFields.pagination.parse(undefined).pageSize}, maximum ${MAX_PAGE_SIZE})`,
      ),
    sort:
      roster === undefined
        ? sort.optional().describe(sortDescription)
        : sort
            .superRefine((value, ctx) => {
              for (const field of value.split(",").map(sortFieldOf))
                if (!roster.fields.includes(field))
                  ctx.addIssue({
                    code: "custom",
                    message: `Unsupported sort field "${field}"; expected one of ${roster.fields.join(", ")}`,
                  });
            })
            .optional()
            .describe(
              `${sortDescription}. Fields: ${roster.fields.join(", ")}. Default: -${roster.default}`,
            ),
    groupBy:
      roster === undefined
        ? sortPaginationFields.groupBy
        : z
            .enum(groupableFieldsOf(roster))
            .optional()
            .describe(
              `Group rows by one field. One of: ${groupableFieldsOf(roster).join(", ")}`,
            ),
  });
};
/**
 * The roster-less controls: what `resourceListInputFrom` re-parses after the
 * route validated the entity-specific query, and the names a filter may not
 * collide with.
 */
const controls = controlsFor();
/** `groupBy` is not narrowed per entity here; the route schema carries the enum. */
type Controls = z.input<typeof controls>;

/** The controls as the query string carries them: numbers coerced from text. */
const queryControlsFor = (roster?: ListSortRoster) => {
  const wire = toWire(controlsFor(roster), "query");
  if (!(wire instanceof z.ZodObject))
    throw new Error("Resource controls must project onto a query object");
  return wire;
};

type Scalarish =
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly unknown[];
type ScalarKeys<T> = {
  [K in keyof T]-?: NonNullable<T[K]> extends Scalarish ? K : never;
}[keyof T];
type ObjectKeys<T> = Exclude<keyof T, ScalarKeys<T>> & string;
type FlatObject<Prefix extends string, O> = {
  [P in keyof O & string as `${Prefix}${Capitalize<P>}`]?: O[P];
};
// The standard distributive-to-intersection helper: each object-valued filter
// contributes its own prefixed keys and the query carries all of them.
type UnionToIntersection<U> = (
  U extends unknown ? (member: U) => void : never
) extends (member: infer I) => void
  ? I
  : never;
/**
 * A filter object with its object-valued members flattened onto prefixed
 * scalar keys (`projectScope.statuses` -> `projectScopeStatuses`), which is
 * what `resourceQueryNesting` does at runtime.
 */
type Flat<T> = T extends unknown
  ? Pick<T, ScalarKeys<T>> &
      UnionToIntersection<
        {
          [K in ObjectKeys<T>]: FlatObject<K, NonNullable<T[K]>>;
        }[ObjectKeys<T>]
      >
  : never;
export type ResourceListQuery<Filters extends z.ZodTypeAny> = Flat<
  Json<z.input<Filters>>
> &
  Controls;

/** Where a flattened query parameter re-nests: `[filter field, member key]`. */
export type ResourceQueryNesting = ReadonlyMap<
  string,
  readonly [field: string, key: string]
>;

const nestingByQuery = new WeakMap<z.ZodType, ResourceQueryNesting>();

const unwrapOptional = (schema: z.ZodType): z.ZodType => {
  if (!(schema instanceof z.ZodOptional || schema instanceof z.ZodNullable))
    return schema;
  const inner = schema.unwrap();
  return inner instanceof z.ZodType ? unwrapOptional(inner) : schema;
};

const flatName = (field: string, key: string) =>
  `${field}${key.charAt(0).toUpperCase()}${key.slice(1)}`;

/**
 * The wire schema of a resource list: the entity's filter fields as flat
 * query parameters plus the paging controls. An object-valued filter is
 * flattened onto `<field><Key>` parameters (one level deep); everything else
 * travels as the query projection of its own schema.
 */
export function resourceListQuery<Filters extends z.ZodObject>(
  filters: Filters,
  roster?: ListSortRoster,
): z.ZodType<ResourceListQuery<Filters>, ResourceListQuery<Filters>> {
  // SAFETY: the strict object is exactly the flattened filter wire shape plus
  // the controls, which is what `ResourceListQuery` spells at the type level;
  // the query projections also accept the JSON form those types name.
  return flatQuery(filters, queryControlsFor(roster)) as z.ZodType<
    ResourceListQuery<Filters>,
    ResourceListQuery<Filters>
  >;
}

/** The entity's filter fields flattened beside a set of control parameters. */
function flatQuery(filters: z.ZodObject, entityControls: z.ZodObject) {
  const nesting = new Map<string, readonly [string, string]>();
  const fields: Record<string, z.ZodType> = {};
  const claim = (name: string, schema: z.ZodType) => {
    if (
      Object.hasOwn(entityControls.shape, name) ||
      Object.hasOwn(fields, name)
    )
      throw new Error(`HTTP resource query parameter collision: ${name}`);
    fields[name] = schema;
  };
  for (const [name, schema] of Object.entries(filters.shape)) {
    const inner = unwrapOptional(schema);
    if (!(inner instanceof z.ZodObject)) {
      claim(name, toWire(schema, "query"));
      continue;
    }
    for (const [key, member] of Object.entries(inner.shape)) {
      if (unwrapOptional(member) instanceof z.ZodObject)
        throw new Error(
          `HTTP resource filter ${name}.${key} nests too deep for query parameters`,
        );
      const flattened = flatName(name, key);
      claim(flattened, toWire(member, "query").optional());
      nesting.set(flattened, [name, key]);
    }
  }
  const query: z.ZodType = z.strictObject({
    ...fields,
    ...entityControls.shape,
  });
  nestingByQuery.set(query, nesting);
  return query;
}

/**
 * A timeline page, spelled like the list's `page`/`pageSize` controls but
 * bounded by the timeline's own page size.
 */
const timelinePagingControls = z.object({
  page: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("Page number, starting at 1 (default 1)"),
  pageSize: z
    .number()
    .int()
    .min(1)
    .max(ENTITY_TIMELINE_MAX_PAGE_SIZE)
    .optional()
    .describe(
      `Records per page (default ${ENTITY_TIMELINE_DEFAULT_PAGE_SIZE}, maximum ${ENTITY_TIMELINE_MAX_PAGE_SIZE})`,
    ),
});

export type ResourceTimelineQuery<
  Filters extends z.ZodTypeAny,
  Id extends z.ZodType<string>,
> = Flat<Json<z.input<Filters>>> &
  z.input<ReturnType<typeof entityTimelineWindowFor<Id>>> &
  z.input<typeof timelinePagingControls>;

/**
 * The wire schema of a resource timeline: the same flat filter parameters as
 * the list plus the timeline window (`ids` repeats its key, `from`/`to` are
 * calendar dates, `order` defaults to newest first) and `page`/`pageSize`.
 */
export function resourceTimelineQuery<
  Filters extends z.ZodObject,
  Id extends z.ZodType<string>,
>(
  filters: Filters,
  id: Id,
): z.ZodType<
  ResourceTimelineQuery<Filters, Id>,
  ResourceTimelineQuery<Filters, Id>
> {
  const window = toWire(
    entityTimelineWindowFor(id).extend(timelinePagingControls.shape),
    "query",
  );
  if (!(window instanceof z.ZodObject))
    throw new Error("Timeline window must project onto a query object");
  // SAFETY: as for `resourceListQuery`, with the window and paging in place
  // of the list controls.
  return flatQuery(filters, window) as z.ZodType<
    ResourceTimelineQuery<Filters, Id>,
    ResourceTimelineQuery<Filters, Id>
  >;
}

/** The flattening a `resourceListQuery` schema performed, for re-nesting. */
export const resourceQueryNesting = (query: z.ZodType): ResourceQueryNesting =>
  nestingByQuery.get(query) ?? new Map();

export interface ResourceListInput {
  filters: Record<string, UnparsedStartOperationData>;
  pagination?: { pageIndex: number; pageSize: number };
  sort?: { orderBy: string; direction: "asc" | "desc" }[];
  groupBy?: string;
}

/** The decoded query values a resource list accepts: JSON values by name. */
export const resourceQueryValues = z.record(
  z.string(),
  unparsedStartOperationDataSchema,
);

const timelineWindowKeys = new Set<string>(
  entityTimelineWindowFor(z.string()).keyof().options,
);

export interface ResourceTimelineInput {
  filters: Record<string, UnparsedStartOperationData>;
  window: Record<string, UnparsedStartOperationData>;
  pagination?: { pageIndex: number; pageSize: number };
}

/** Map a validated resource-timeline query onto the entity timeline input. */
export function resourceTimelineInputFrom(
  values: z.output<typeof resourceQueryValues>,
  nesting: ResourceQueryNesting,
): ResourceTimelineInput {
  const window: Record<string, UnparsedStartOperationData> = {};
  const rest: Record<string, UnparsedStartOperationData> = {};
  const { page, pageSize } = timelinePagingControls.parse({
    page: values.page,
    pageSize: values.pageSize,
  });
  for (const [name, value] of Object.entries(values)) {
    if (Object.hasOwn(timelinePagingControls.shape, name)) continue;
    if (timelineWindowKeys.has(name)) window[name] = value;
    else rest[name] = value;
  }
  const input: ResourceTimelineInput = {
    filters: resourceListInputFrom(rest, nesting).filters,
    window,
  };
  if (page !== undefined || pageSize !== undefined)
    input.pagination = {
      pageIndex: (page ?? 1) - 1,
      pageSize: pageSize ?? ENTITY_TIMELINE_DEFAULT_PAGE_SIZE,
    };
  return input;
}

/** Map a validated resource-list query onto the entity list operation input. */
export function resourceListInputFrom(
  values: z.output<typeof resourceQueryValues>,
  nesting: ResourceQueryNesting,
): ResourceListInput {
  const { page, pageSize, sort, groupBy } = controls.parse(values);
  const filters: Record<string, UnparsedStartOperationData> = {};
  const nested: Record<string, Record<string, UnparsedStartOperationData>> = {};
  for (const [name, value] of Object.entries(values)) {
    if (Object.hasOwn(controls.shape, name)) continue;
    const target = nesting.get(name);
    if (target === undefined) {
      filters[name] = value;
      continue;
    }
    const [field, key] = target;
    const holder = nested[field] ?? {};
    holder[key] = value;
    nested[field] = holder;
    filters[field] = holder;
  }
  const input: ResourceListInput = { filters };
  if (page !== undefined || pageSize !== undefined)
    input.pagination = {
      pageIndex: (page ?? 1) - 1,
      pageSize:
        pageSize ?? sortPaginationFields.pagination.parse(undefined).pageSize,
    };
  if (sort !== undefined)
    input.sort = sort.split(",").map((field) => ({
      orderBy: field.startsWith("-") ? field.slice(1) : field,
      direction: field.startsWith("-") ? "desc" : "asc",
    }));
  if (groupBy !== undefined) input.groupBy = groupBy;
  return input;
}
