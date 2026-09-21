import { UNRESOLVABLE_ENTITY_FILTER } from "@cubby/shared";
import { z } from "zod";

export const MAX_PAGE_SIZE = 500;

const sortParams = z.object({
  orderBy: z.string().default("createdAt"),
  direction: z.enum(["asc", "desc"]).default("asc"),
});

export const MAX_SORTS = 3;

/**
 * List `sort` input: a single `{orderBy, direction}` (the historical shape —
 * MCP tools and old clients keep sending it) or a shift-click stack of them.
 * Server code never consumes this union directly — `normalizeSorts` collapses
 * it once at the transport boundary.
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
 * `mcpListInputFields`, and an LLM (or an old link) passing `trade: "drywall"`
 * must stay valid. Repos resolve either shape through `eqAny`.
 */
export const oneOrMany = <T extends z.ZodTypeAny>(schema: T) =>
  z.union([schema, z.array(schema)]);

/**
 * A route asked for an exact entity filter, but its value was not a valid
 * shortcode. This value is deliberately NOT a shortcode: the route boundary
 * produces it, then `resolveFilterIds` resolves it to an empty id set so the
 * request matches nothing. Ordinary entity-id inputs keep the canonical
 * shortcode schema, inferred brand, and published regex.
 *
 * Keeping this distinct from omission is load-bearing. Omitted filters are
 * unrestricted; a requested but invalid filter must never widen into one.
 */
/**
 * A single exact-entity filter that accepts only the internal match-nothing
 * value in addition to its canonical shortcode schema.
 *
 * The union's JSON metadata is DERIVED from the canonical schema. Publishing
 * its pattern at the field level keeps MCP clients on the public shortcode
 * contract: the internal value can round-trip through JSON transport, but is not
 * advertised as a valid external id. The output type deliberately exposes the
 * sentinel as a separate literal alongside the canonical brand, so internal
 * callers must handle the invalid-filter state instead of treating it as an
 * entity id. Only the URL filter boundary produces that literal.
 */
export const entityFilter = <T extends z.ZodTypeAny>(schema: T) => {
  const jsonSchema = z.toJSONSchema(schema);
  return z.union([schema, z.literal(UNRESOLVABLE_ENTITY_FILTER)]).meta({
    type: jsonSchema.type,
    pattern: jsonSchema.pattern,
    description: jsonSchema.description,
  });
};

export const entityFilterList = <T extends z.ZodTypeAny>(schema: T) =>
  oneOrMany(entityFilter(schema));

const paginationParams = z.object({
  pageIndex: z.number().int().min(0).default(0),
  pageSize: z.number().int().min(1).max(MAX_PAGE_SIZE).default(10),
});

export function mcpPageSizeParam(opts: {
  defaultPageSize: number;
  maxPageSize: number;
}) {
  const { defaultPageSize, maxPageSize } = opts;
  return z
    .number()
    .int()
    .min(1)
    .max(maxPageSize)
    .default(defaultPageSize)
    .describe(
      `Items per page (default ${defaultPageSize}, max ${maxPageSize})`,
    );
}

export function mcpPaginationFields(opts: {
  defaultPageSize: number;
  maxPageSize: number;
}) {
  return {
    pageIndex: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe("Page index, 0-based (default 0)"),
    pageSize: mcpPageSizeParam(opts),
  };
}

export function mcpListInputFields(
  filterFields: Record<string, z.ZodType>,
  opts?: { defaultPageSize?: number; maxPageSize?: number },
) {
  return {
    ...filterFields,
    ...mcpPaginationFields({
      defaultPageSize: opts?.defaultPageSize ?? 50,
      maxPageSize: opts?.maxPageSize ?? 100,
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
  type PaginatedMeta = {
    pageIndex: number;
    pageSize: number;
    totalCount: number;
    sums?: Record<string, number>;
  };
  const meta: PaginatedMeta = {
    pageIndex: pagination.pageIndex,
    pageSize: pagination.pageSize,
    totalCount: count,
  };
  if (sums) meta.sums = sums;
  return {
    meta,
    items: data,
  };
}

/** One page's metadata; a single component every list page shares. */
export const paginatedMetaSchema = z
  .object({
    pageIndex: z.number().int().nonnegative(),
    pageSize: z.number().int().positive().max(MAX_PAGE_SIZE),
    totalCount: z.number().int().nonnegative(),
    sums: z.record(z.string(), z.number()).optional(),
  })
  .meta({ id: "ListPageMeta" });

export function createPaginatedResponseSchema<Entry extends z.ZodTypeAny>(
  entrySchema: Entry,
) {
  return z.object({
    meta: paginatedMetaSchema,
    items: z.array(entrySchema),
  });
}

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
  const context = z.check<z.output<Entry>[]>((payload) => {
    payload.issues = payload.issues.map((issue) => {
      const index = z.number().safeParse(issue.path?.[0]);
      if (!index.success) return issue;
      const record = identifyRecord(payload.value[index.data], index.data);
      const description = formatRecordIdentifier(record);
      const detail = z.core.util.finalizeIssue(
        issue,
        undefined,
        z.config(),
      ).message;
      const message = `[${entityName} ${description}] ${issue.path?.slice(1).join(".")}: ${detail}`;
      console.error(`[OutputValidation] ${message}`);
      return { ...issue, message };
    });
  });
  // Error decoration must run even when a record's field parsing aborted.
  context._zod.def.when = () => true;
  return z.object({
    meta: paginatedMetaSchema,
    items: z.array(entrySchema).check(context),
  });
}

/**
 * Identifies a record for error messages.
 */
const recordIdentifierSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
});
type RecordIdentifier = z.infer<typeof recordIdentifierSchema> & {
  index: number;
};

function identifyRecord<TRecord>(
  record: TRecord,
  index: number,
): RecordIdentifier {
  const parsed = recordIdentifierSchema.safeParse(record);
  return parsed.success ? { ...parsed.data, index } : { index };
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
