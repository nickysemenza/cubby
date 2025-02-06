import { type PrismaClient, type Prisma } from "@prisma/client";
import { type ProductConfigItem } from "~/server/config";
import { findOrCreateIngredient } from "./ingredients";
import { z } from "zod";
import { createTRPCRouter, publicProcedure } from "../trpc";
import { productWithIngredientOut } from "~/schemas/ingredient";
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
    let item = undefined;
    if (product.ingredient) {
      //  only link item if its an ingredient

      item = await findOrCreateIngredient(db, product.name);
    }
    const upsertFields: Prisma.ProductCreateInput = {
      name,
      manufacturer,
      upc,
      model,
      updatedAt: now,
      Ingredient: item ? { connect: { id: item.id } } : undefined,
    };
    const productRow = await db.product.upsert({
      where: {
        name_manufacturer: {
          name: name,
          manufacturer: manufacturer,
        },
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
  .output(productWithIngredientOut)
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
  Ingredient: true,
  unitMappings: true,
};

type ProductDeepDB = Prisma.ProductGetPayload<{
  include: {
    Ingredient: true;
    unitMappings: true;
  };
}>;

const dbProductoToAPI: (
  product: ProductDeepDB,
) => z.infer<typeof productWithIngredientOut> = (product) => {
  const { Ingredient, unitMappings, ...restOfIngredient } = product;

  return {
    ...restOfIngredient,
    ingredient: Ingredient,
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
  .output(createPaginatedResponseSchema(productWithIngredientOut))
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
