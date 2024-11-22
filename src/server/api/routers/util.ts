import { z } from "zod";

export const sortParams = z.object({
  orderBy: z.string(),
  direction: z.enum(["asc", "desc"]),
});
export const paginationParams = z.object({
  pageIndex: z.number(),
  pageSize: z.number(),
});
export const buildTakeSkip = (pagination: PaginationParams) => {
  return {
    skip: pagination.pageIndex * pagination.pageSize,
    take: pagination.pageSize,
  };
};
export type PaginationParams = z.infer<typeof paginationParams>;
export type SortParams = z.infer<typeof sortParams>;

export const dbTimestamps = z.object({
  createdAt: z.date(),
  updatedAt: z.date(),
});

export function createPaginatedResponseSchema<ItemType extends z.ZodTypeAny>(
  itemSchema: ItemType,
) {
  return z.object({
    meta: z.object({
      pageIndex: z.number(),
      pageSize: z.number(),
      totalCount: z.number(),
      // totalPages: z.number(),
    }),
    items: z.array(itemSchema),
  });
}
