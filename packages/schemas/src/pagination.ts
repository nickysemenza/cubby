import { UNRESOLVABLE_ENTITY_FILTER } from "@cubby/shared";
import { z } from "zod";

export const MAX_PAGE_SIZE = 500;

const sortParams = z.object({
  orderBy: z.string().default("createdAt"),
  direction: z.enum(["asc", "desc"]).default("asc"),
});

/** Hard cap on stacked sort columns (client and server both enforce it). */
export const MAX_SORTS = 3;

/**
 * List `sort` input: a single `{orderBy, direction}` (the historical shape —
 * MCP tools and old clients keep sending it) or a shift-click stack of them.
 * Server code never consumes this union directly — `normalizeSorts` collapses
 * it once at the tRPC boundary.
 */
const sortInput = z.union([
  sortParams,
  z.array(sortParams).min(1).max(MAX_SORTS),
]);

/**
 * Deliberately as wide as the schema's OUTPUT, not its `.min(1)` constraint —
 * `normalizeSorts` consumes parsed input, so narrowing here only breaks the
 * consumers.
 *
 * The caller-facing type comes from zod inference, so `sort: []` compiles and
 * then 400s at runtime. That cost a product page ("No locations are an
 * instance of this product" over a product with fourteen) and a silently empty
 * filter dropdown. Making it a compile error means a non-empty TUPLE in the
 * schema itself, which changes the JSON Schema MCP advertises from a plain
 * array to `prefixItems` — a worse trade than a test.
 */
export type SortInput = SortParams | SortParams[];

/**
 * Single-or-array → non-empty array, deduped by orderBy (first occurrence
 * wins — a stacked sort repeating a column adds nothing), capped at MAX_SORTS.
 */
export const normalizeSorts = (sort: SortInput): SortParams[] => {
  const arr = Array.isArray(sort) ? sort : [sort];
  const seen = new Set<string>();
  const out: SortParams[] = [];
  for (const s of arr) {
    if (seen.has(s.orderBy)) continue;
    seen.add(s.orderBy);
    out.push(s);
    if (out.length === MAX_SORTS) break;
  }
  return out;
};

type NonEmptyStringArray = readonly [string, ...string[]];

export const createSortParamsSchema = <
  TFields extends NonEmptyStringArray,
  TDefault extends TFields[number],
>(
  fields: TFields,
  defaultOrderBy: TDefault,
) => {
  const single = z.object({
    orderBy: z.enum(fields).default(defaultOrderBy),
    direction: z.enum(["asc", "desc"]).default("asc"),
  });
  return z.union([single, z.array(single).min(1).max(MAX_SORTS)]);
};

/**
 * Relation-presence filter for list endpoints: "has" keeps rows with the
 * relation, "none" keeps rows without it, unset means any. Sorting keeps the
 * NULLS-LAST-both-directions convention, so this filter (surfaced as a header
 * select on relation columns) is the way to find empty-relation rows.
 */
export const presenceFilter = z.enum(["has", "none"]).optional();
export type PresenceFilter = z.infer<typeof presenceFilter>;

/**
 * Stable calendar predicates whose boundary is resolved by the server using
 * Cubby's household clock. Unlike serializing today's literal date into a
 * saved view, these values remain truthful when a bookmarked worklist is
 * opened tomorrow.
 */
export const relativeDateFilter = z.enum(["beforeToday", "onOrBeforeToday"]);
export type RelativeDateFilter = z.infer<typeof relativeDateFilter>;

/**
 * Accept one value or a set of them for the same filter — the shape a
 * multi-select column filter produces.
 *
 * A union rather than a bare array so existing SCALAR callers keep working:
 * these `*FilterFields` are spread into the MCP tool inputs via
 * `mcpListInputShape`, and an LLM (or an old link) passing `trade: "drywall"`
 * must stay valid. Repos resolve either shape through `eqAny`.
 */
export const oneOrMany = <T extends z.ZodTypeAny>(schema: T) =>
  z.union([schema, z.array(schema)]);

/**
 * A route asked for an exact entity filter, but its value was not a valid
 * shortcode. This value is deliberately NOT a shortcode: the filter-only
 * schema's failure path produces it, then `resolveFilterIds` resolves it to an
 * empty id set so the request matches nothing. Ordinary entity-id inputs keep
 * the canonical shortcode schema, inferred brand, and published regex.
 *
 * Keeping this distinct from omission is load-bearing. Omitted filters are
 * unrestricted; a requested but invalid filter must never widen into one.
 */
/** A single exact-entity filter with a match-nothing validation fallback. */
export const entityFilter = <T extends z.ZodTypeAny>(schema: T) =>
  schema.catch(() => UNRESOLVABLE_ENTITY_FILTER as z.output<T>);

/** One-or-many exact-entity filters with the same match-nothing fallback. */
export const entityFilterList = <T extends z.ZodTypeAny>(schema: T) => {
  const list = oneOrMany(schema);
  return list.catch(() => UNRESOLVABLE_ENTITY_FILTER as z.output<typeof list>);
};

const paginationParams = z.object({
  pageIndex: z.number().int().min(0).default(0),
  pageSize: z.number().int().min(1).max(MAX_PAGE_SIZE).default(10),
});

/**
 * Pagination fields for MCP list/search tools, as a raw shape to spread into a
 * tool's input schema: `{ ...mcpPaginationParams }`. Both are optional (the MCP
 * list handler defaults to page 0 / size 50) and the descriptions surface to MCP
 * clients. Kept here so every list tool stops re-declaring the same two fields.
 */
export const mcpPaginationParams = {
  pageIndex: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Page index, 0-based (default 0)"),
  pageSize: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Items per page (default 50, max 100)"),
};

export function mcpPageSizeParam(opts?: {
  defaultPageSize?: number;
  max?: number;
}) {
  const max = opts?.max ?? 100;
  const def = opts?.defaultPageSize ?? 50;
  return z
    .number()
    .int()
    .min(1)
    .max(max)
    .optional()
    .describe(`Items per page (default ${def}, max ${max})`);
}

export function mcpListInputShape(
  filterFields: Record<string, z.ZodType>,
  opts?: { defaultPageSize?: number; maxPageSize?: number },
) {
  return {
    ...filterFields,
    pageIndex: mcpPaginationParams.pageIndex,
    pageSize: mcpPageSizeParam({
      defaultPageSize: opts?.defaultPageSize,
      max: opts?.maxPageSize,
    }),
  };
}

export const sortPaginationFields = {
  sort: sortInput
    .optional()
    .default({ orderBy: "createdAt", direction: "desc" }),
  pagination: paginationParams
    .optional()
    .default({ pageIndex: 0, pageSize: 10 }),
  groupBy: z.string().optional(),
};

export const createSortPaginationFields = <
  TFields extends NonEmptyStringArray,
  TDefault extends TFields[number],
>(opts: {
  sortableFields: TFields;
  defaultSort: TDefault;
  groupableFields?: TFields;
}) => ({
  sort: createSortParamsSchema(opts.sortableFields, opts.defaultSort)
    .optional()
    .default({ orderBy: opts.defaultSort, direction: "desc" }),
  pagination: paginationParams
    .optional()
    .default({ pageIndex: 0, pageSize: 10 }),
  groupBy: opts.groupableFields
    ? z.enum(opts.groupableFields).optional()
    : z.enum(opts.sortableFields).optional(),
});

export const sortPaginationCombo = z.object(sortPaginationFields);

export const buildTakeSkip = (pagination: PaginationParams) => {
  return {
    skip: pagination.pageIndex * pagination.pageSize,
    take: pagination.pageSize,
  };
};

export type PaginationParams = z.infer<typeof paginationParams>;
export type SortParams = z.infer<typeof sortParams>;

export function buildPaginatedResponse<T>(
  pagination: PaginationParams,
  data: T[],
  count: number,
  /**
   * Server-computed column aggregates over the FULL filtered set (not the
   * page), keyed by column id — e.g. `{ price: 1234.5 }`. Surfaced so table
   * footers can show truthful totals on server-paginated lists.
   */
  sums?: Record<string, number>,
) {
  return {
    meta: {
      pageIndex: pagination.pageIndex,
      pageSize: pagination.pageSize,
      totalCount: count,
      ...(sums ? { sums } : {}),
    },
    items: data,
  };
}

const paginatedMetaSchema = z.object({
  pageIndex: z.number().int().nonnegative(),
  pageSize: z.number().int().positive().max(MAX_PAGE_SIZE),
  totalCount: z.number().int().nonnegative(),
  // Full-filtered-set column aggregates (see buildPaginatedResponse).
  sums: z.record(z.string(), z.number()).optional(),
});

export function createPaginatedResponseSchema<Entry extends z.ZodTypeAny>(
  entrySchema: Entry,
) {
  return z.object({
    meta: paginatedMetaSchema,
    items: z.array(entrySchema),
  });
}

/** Bulk tool result envelope: `{ items: T[] }` (replaces bare array roots). */
export function createItemsResponseSchema<Entry extends z.ZodTypeAny>(
  entrySchema: Entry,
) {
  return z.object({
    items: z.array(entrySchema),
  });
}

/**
 * Creates a paginated response schema with enhanced error context.
 * When validation fails, error messages include record identifiers (id, name, index).
 */
export function createPaginatedResponseSchemaWithContext<
  Entry extends z.ZodTypeAny,
>(entrySchema: Entry, entityName: string) {
  return z.object({
    meta: paginatedMetaSchema,
    items: z.array(z.unknown()).transform((items, ctx) => {
      const results: z.infer<Entry>[] = [];
      let hasErrors = false;

      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const parseResult = entrySchema.safeParse(item);

        if (parseResult.success) {
          results.push(parseResult.data);
        } else {
          hasErrors = true;
          const recordInfo = identifyRecord(item, i);
          const recordStr = formatRecordIdentifier(recordInfo);

          console.error(
            `[OutputValidation] ${entityName} validation failed for ${recordStr}:`,
            parseResult.error.issues.map((issue) => ({
              path: issue.path.join("."),
              message: issue.message,
            })),
          );

          for (const issue of parseResult.error.issues) {
            ctx.addIssue({
              ...issue,
              path: [i, ...issue.path],
              message: `[${entityName} ${recordStr}] ${issue.path.join(".")}: ${issue.message}`,
            });
          }
        }
      }

      if (hasErrors) {
        return z.NEVER;
      }

      return results;
    }),
  });
}

/**
 * Identifies a record for error messages.
 */
function identifyRecord(
  record: unknown,
  index: number,
): { id?: string; name?: string; index: number } {
  const result: { id?: string; name?: string; index: number } = { index };

  if (record && typeof record === "object") {
    const obj = record as Record<string, unknown>;
    if (typeof obj.id === "string") result.id = obj.id;
    if (typeof obj.name === "string") result.name = obj.name;
  }

  return result;
}

/**
 * Format record identifier for error messages.
 */
function formatRecordIdentifier(info: {
  id?: string;
  name?: string;
  index: number;
}): string {
  const parts: string[] = [];
  if (info.name) parts.push(`"${info.name}"`);
  if (info.id) parts.push(`id=${info.id}`);
  parts.push(`index=${info.index}`);
  return parts.join(", ");
}
