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
export type ResourceListQuery<Filters extends z.ZodTypeAny> = Json<
  z.input<Filters>
> &
  Controls;

/**
 * The wire schema of a resource list: the entity's filter fields as flat
 * query parameters plus the paging controls. Structured filter values travel
 * JSON-encoded per ts-rest's `jsonQuery`.
 */
export function resourceListQuery<Filters extends z.ZodObject>(
  filters: Filters,
): z.ZodType<ResourceListQuery<Filters>, ResourceListQuery<Filters>> {
  for (const name of Object.keys(filters.shape)) {
    if (Object.hasOwn(controls.shape, name))
      throw new Error(`HTTP resource query parameter collision: ${name}`);
  }
  const wire = toWire(filters, "input");
  if (!(wire instanceof z.ZodObject))
    throw new Error("Resource filters must be an object schema");
  const query: z.ZodType = z.strictObject({ ...wire.shape, ...controls.shape });
  // SAFETY: the strict object is exactly the filter wire shape plus the
  // controls, which is what `ResourceListQuery` spells at the type level.
  return query as z.ZodType<
    ResourceListQuery<Filters>,
    ResourceListQuery<Filters>
  >;
}

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
): ResourceListInput {
  const { page, pageSize, sort, groupBy } = controls.parse(values);
  const filters = Object.fromEntries(
    Object.entries(values).filter(
      ([name]) => !Object.hasOwn(controls.shape, name),
    ),
  );
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
