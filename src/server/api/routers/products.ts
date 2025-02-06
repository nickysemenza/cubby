import { type PrismaClient, type Prisma } from "@prisma/client";
import { type ProductConfigItem } from "~/server/config";
import { findOrCreateItem } from "./item";
import { z } from "zod";
import { createTRPCRouter, publicProcedure } from "../trpc";
import { productWithItemOut } from "~/schemas/item";
import {
  createPaginatedResponseSchema,
  IDInput,
  buildTakeSkip,
  sortPaginationCombo,
} from "~/schemas/util";

export const loadProducts = async (
  db: PrismaClient,
  data: ProductConfigItem[],
) => {
  const now = new Date();

  for (const product of data) {
    const { name, manufacturer, upc, model } = product;
    const item = await findOrCreateItem(db, product.name, product.productType);
    //todo: do something with product.unit_mappings
    const upsertFields: Prisma.ProductCreateInput = {
      name,
      manufacturer,
      upc,
      model,
      updatedAt: now,
      Item: { connect: { id: item.id } },
    };
    const productRow = await db.product.upsert({
      where: {
        name,
      },
      create: {
        ...upsertFields,
      },
      update: {
        ...upsertFields,
      },
    });

    // todo: don't delete mappings managed outside of yaml
    await db.productUnitMappings.deleteMany({
      where: { productId: productRow.id },
    });
    await db.productUnitMappings.createMany({
      data: product.unit_mappings.map(
        (unitMapping): Prisma.ProductUnitMappingsCreateManyInput => ({
          productId: productRow.id,
          a: unitMapping.a,
          b: unitMapping.b,
          source: unitMapping.source,
        }),
      ),
    });
  }

  const stale = await db.product.findMany({
    where: {
      updatedAt: {
        not: now,
      },
    },
  });
  console.log({ stale: stale.map((s) => s.id) });
};

const getByID = publicProcedure
  .input(IDInput)
  .output(productWithItemOut)
  .query(async ({ ctx, input }) => {
    const res = await ctx.db.product.findFirstOrThrow({
      where: {
        id: input.id,
      },
      include: productInclude,
    });
    return dbProductoToAPI(res);
  });

const productInclude: Prisma.ProductInclude = {
  Item: true,
  unitMappings: true,
};

type ProductDeepDB = Prisma.ProductGetPayload<{
  include: {
    Item: true;
    unitMappings: true;
  };
}>;

const dbProductoToAPI: (
  item: ProductDeepDB,
) => z.infer<typeof productWithItemOut> = (item) => {
  const { Item, unitMappings, ...restOfItem } = item;

  return {
    ...restOfItem,
    item: Item,
    unitMappings,
  };
};

const list = publicProcedure
  .input(
    z
      .object({
        nameFilter: z.string().optional(),
      })
      .merge(sortPaginationCombo),
  )
  .output(createPaginatedResponseSchema(productWithItemOut))
  .query(async ({ ctx, input }) => {
    const orderBy: Prisma.ProductOrderByWithAggregationInput = {
      createdAt:
        input.sort.orderBy === "createdAt" ? input.sort.direction : undefined,
      name: input.sort.orderBy === "name" ? input.sort.direction : undefined,
    };
    const where: Prisma.ProductWhereInput = {
      name: input.nameFilter != "" ? { search: input.nameFilter } : undefined,
    };
    const res = await ctx.db.product.findMany({
      orderBy,
      where,
      ...buildTakeSkip(input.pagination),
      include: productInclude,
    });
    const totalCount = await ctx.db.product.count({ where });
    const products = res.map(dbProductoToAPI);
    return {
      meta: {
        pageIndex: input.pagination.pageIndex,
        pageSize: products.length,
        totalCount,
        // totalPages: 1,
      },
      items: products,
    };
  });

export const productRouter = createTRPCRouter({
  getByID,
  list,
});
