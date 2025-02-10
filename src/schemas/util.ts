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
  pagination: paginationParams.optional().default({ pageSize: 10 }),
});

export const buildTakeSkip = (pagination: PaginationParams) => {
  return {
    skip: pagination.pageIndex * pagination.pageSize,
    take: pagination.pageSize,
  };
};
export type PaginationParams = z.infer<typeof paginationParams>;
export type SortParams = z.infer<typeof sortParams>;

export const dbTimestampsOut = z
  .object({
    createdAt: z.date(),
    updatedAt: z.date(),
  })
  .describe("db timestamps for an API response");
export function extractDbTimestampsFromDBRec<
  T extends { createdAt: Date; updatedAt: Date },
>(dbRec: T): z.infer<typeof dbTimestampsOut> {
  return {
    createdAt: dbRec.createdAt,
    updatedAt: dbRec.updatedAt,
  };
}
export function buildPaginatedResponse<T>(
  pagination: PaginationParams,
  data: T[],
  count: number,
) {
  return {
    meta: {
      pageIndex: pagination.pageIndex,
      pageSize: data.length, //todo: is this wrong (if len is shorter than req)
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
      // totalPages: z.number(),
    }),
    items: z.array(entrySchema),
  });
}

export const IDInput = z
  .object({
    id: z.string().uuid().describe("UUID"),
  })
  .describe("input for retrieving by ID");
