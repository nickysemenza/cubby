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
 * Resource-list controls. They ride alongside the entity's flat filter
 * parameters, so a filter may not reuse one of these names.
 */
const controls = z.object({
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
  sort: z
    .string()
    .regex(
      new RegExp(
        `^-?[^,\\s-][^,\\s]*(,-?[^,\\s-][^,\\s]*){0,${MAX_SORTS - 1}}$`,
        "u",
      ),
    )
    .optional()
    .describe(
      `Comma-separated fields; prefix with - for descending. Maximum ${MAX_SORTS} fields. Example: name,-createdAt`,
    ),
  groupBy: sortPaginationFields.groupBy,
});
type Controls = z.input<typeof controls>;

/** The controls as the query string carries them: numbers coerced from text. */
const queryControls = (() => {
  const wire = toWire(controls, "query");
  if (!(wire instanceof z.ZodObject))
    throw new Error("Resource controls must project onto a query object");
  return wire;
})();

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
): z.ZodType<ResourceListQuery<Filters>, ResourceListQuery<Filters>> {
  const nesting = new Map<string, readonly [string, string]>();
  const fields: Record<string, z.ZodType> = {};
  const claim = (name: string, schema: z.ZodType) => {
    if (Object.hasOwn(queryControls.shape, name) || Object.hasOwn(fields, name))
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
    ...queryControls.shape,
  });
  nestingByQuery.set(query, nesting);
  // SAFETY: the strict object is exactly the flattened filter wire shape plus
  // the controls, which is what `ResourceListQuery` spells at the type level;
  // the query projections also accept the JSON form those types name.
  return query as z.ZodType<
    ResourceListQuery<Filters>,
    ResourceListQuery<Filters>
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
