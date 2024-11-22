import { z } from "zod";
import { createTRPCRouter, publicProcedure } from "../trpc";
import { ItemType, type Prisma } from "@prisma/client";
import {
  createPaginatedResponseSchema,
  dbTimestamps,
  paginationParams,
  sortParams,
  buildTakeSkip,
} from "./util";

type ItemDeepDB = Prisma.ItemGetPayload<{
  include: {
    Product: true;
    Recipe: true;
  };
}>;

const dbItemToAPI: (item: ItemDeepDB) => ItemOut = (item) => {
  const { ...restOfItem } = item;

  return {
    ...restOfItem,
  };
};

export type ItemOut = z.infer<typeof itemOut>;
const itemOut = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    type: z.nativeEnum(ItemType),
  })
  .merge(dbTimestamps);

export const itemRouter = createTRPCRouter({
  list: publicProcedure
    .input(
      z.object({
        sort: sortParams,
        pagination: paginationParams,
        nameFilter: z.string().optional(),
      }),
    )
    .output(createPaginatedResponseSchema(itemOut))
    .query(async ({ ctx, input }) => {
      const orderBy: Prisma.ItemOrderByWithAggregationInput = {
        createdAt:
          input.sort.orderBy === "createdAt" ? input.sort.direction : undefined,
        name: input.sort.orderBy === "name" ? input.sort.direction : undefined,
      };
      const where: Prisma.ItemWhereInput = {
        name: input.nameFilter != "" ? { search: input.nameFilter } : undefined,
      };
      const res = await ctx.db.item.findMany({
        orderBy,
        where,
        ...buildTakeSkip(input.pagination),
        include: {
          Product: true,
          Recipe: true,
        },
      });
      const totalCount = await ctx.db.item.count({ where });
      const items = res.map(dbItemToAPI);
      return {
        meta: {
          pageIndex: input.pagination.pageIndex,
          pageSize: items.length,
          totalCount,
          // totalPages: 1,
        },
        items,
      };
    }),
});
