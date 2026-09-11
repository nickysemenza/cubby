import {
  MAX_PAGE_SIZE,
  MAX_SORTS,
  sortPaginationFields,
} from "@cubby/schemas/pagination";
import { parseJsonQueryObject } from "@ts-rest/core";
import { z } from "zod";

import { unparsedStartOperationDataSchema } from "~/server/start-operation.contract";

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
export const resourceQueryValues = z.record(
  z.string(),
  unparsedStartOperationDataSchema,
);

export function resourceParameterIsText(schema: z.core.$ZodType): boolean {
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodDefault)
    return resourceParameterIsText(schema.unwrap());
  return (
    schema instanceof z.ZodString ||
    (schema instanceof z.ZodEnum &&
      schema.options.every((value) => z.string().safeParse(value).success))
  );
}

export function resourceListQuerySchema<S extends z.ZodRawShape>(
  filters: z.ZodObject<S>,
) {
  for (const name of Object.keys(filters.shape)) {
    if (Object.hasOwn(controls.shape, name))
      throw new Error(`HTTP resource query parameter collision: ${name}`);
  }
  return z.strictObject({ ...filters.shape, ...controls.shape });
}

interface ResourceListInput {
  filters: z.output<typeof resourceQueryValues>;
  pagination?: { pageIndex: number; pageSize: number };
  sort?: { orderBy: string; direction: "asc" | "desc" }[];
  groupBy?: string;
}

export function decodeResourceListQuery(
  params: URLSearchParams,
  schema: z.ZodObject,
) {
  if (new Set(params.keys()).size !== params.size)
    throw new Error("Duplicate query parameters");
  const decoded = resourceQueryValues.parse(
    parseJsonQueryObject(Object.fromEntries(params)),
  );
  // Text filters keep literal URL text; structured filters use the JSON decoder.
  for (const [name, raw] of params) {
    const field = schema.shape[name];
    if (!field) throw new Error(`Unknown query parameter: ${name}`);
    if (
      resourceParameterIsText(field) ||
      !field.safeParse(decoded[name]).success
    )
      decoded[name] = raw;
  }
  schema.parse(decoded);
  const { page, pageSize, sort, groupBy } = controls.parse(decoded);
  const filters = Object.fromEntries(
    Object.entries(decoded).filter(
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
