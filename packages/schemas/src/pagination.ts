import { z } from "zod";

const sortParams = z.object({
  orderBy: z.string().default("createdAt"),
  direction: z.enum(["asc", "desc"]).default("asc"),
});

const paginationParams = z.object({
  pageIndex: z.number().min(0).default(0),
  pageSize: z.number().min(1).default(10),
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

export const sortPaginationFields = {
  sort: sortParams
    .optional()
    .default({ orderBy: "createdAt", direction: "desc" }),
  pagination: paginationParams
    .optional()
    .default({ pageIndex: 0, pageSize: 10 }),
  groupBy: z.string().optional(),
};

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
) {
  return {
    meta: {
      pageIndex: pagination.pageIndex,
      pageSize: pagination.pageSize,
      totalCount: count,
    },
    items: data,
  };
}

export function createPaginatedResponseSchema<Entry extends z.ZodTypeAny>(
  entrySchema: Entry,
) {
  return z.object({
    meta: z.object({
      pageIndex: z.number(),
      pageSize: z.number(),
      totalCount: z.number(),
    }),
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
    meta: z.object({
      pageIndex: z.number(),
      pageSize: z.number(),
      totalCount: z.number(),
    }),
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
          // Extract identifying info from the record
          const recordInfo = identifyRecord(item, i);
          const recordStr = formatRecordIdentifier(recordInfo);

          // Log detailed error for server-side debugging
          console.error(
            `[OutputValidation] ${entityName} validation failed for ${recordStr}:`,
            parseResult.error.issues.map((issue) => ({
              path: issue.path.join("."),
              message: issue.message,
            })),
          );

          // Add each issue with record context
          for (const issue of parseResult.error.issues) {
            ctx.addIssue({
              ...issue,
              path: [i, ...issue.path],
              message: `[${entityName} ${recordStr}] ${issue.path.join(".")}: ${issue.message}`,
            });
          }
        }
      }

      // Must return z.NEVER when there are errors to signal validation failure
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
