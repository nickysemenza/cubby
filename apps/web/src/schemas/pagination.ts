import { z } from "zod";

const sortParams = z.object({
  orderBy: z.string().default("createdAt"),
  direction: z.enum(["asc", "desc"]).default("asc"),
});

const paginationParams = z.object({
  pageIndex: z.number().default(0),
  pageSize: z.number().default(10),
});

export const sortPaginationCombo = z.object({
  sort: sortParams
    .optional()
    .default({ orderBy: "createdAt", direction: "desc" }),
  pagination: paginationParams
    .optional()
    .default({ pageIndex: 0, pageSize: 10 }),
});

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
