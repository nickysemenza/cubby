import { type Prisma, type PrismaClient } from "@prisma/client";
import { type ProductConfigItem } from "../config";
import { findOrCreateIngredient } from "./ingredient";
import { type productWithIngredientOut } from "~/schemas/ingredient";
import { type z } from "zod";
import {
  type SortParams,
  type PaginationParams,
  buildTakeSkip,
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

      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
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

export const getProductByID = async (db: PrismaClient, id: string) => {
  const res = await db.product.findFirstOrThrow({
    where: {
      id,
    },
    include: productInclude,
  });
  return dbProductoToAPI(res);
};

export const productList = async (
  db: PrismaClient,
  name: string | undefined,
  sort: SortParams,
  pagination: PaginationParams,
) => {
  const orderBy: Prisma.ProductOrderByWithAggregationInput = {
    createdAt: sort.orderBy === "createdAt" ? sort.direction : undefined,
    name: sort.orderBy === "name" ? sort.direction : undefined,
    manufacturer: sort.orderBy === "manufacturer" ? sort.direction : undefined,
    model: sort.orderBy === "model" ? sort.direction : undefined,
    upc: sort.orderBy === "upc" ? sort.direction : undefined,
  };
  const where: Prisma.ProductWhereInput = {
    name: name != "" ? { search: name } : undefined,
  };
  const res = await db.product.findMany({
    orderBy,
    where,
    ...buildTakeSkip(pagination),
    include: productInclude,
  });
  const totalCount = await db.product.count({ where });
  const products = res.map(dbProductoToAPI);
  return { data: products, count: totalCount };
};
