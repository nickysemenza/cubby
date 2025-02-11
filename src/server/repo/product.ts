import { type Prisma, type PrismaClient } from "@prisma/client";
import { type ProductConfigItem } from "../../schemas/config";
import { findOrCreateIngredient } from "./ingredient";
import {
  type unitMappingBase,
  type productWithIngredientOut,
} from "~/schemas/ingredient";
import { type z } from "zod";
import {
  type SortParams,
  type PaginationParams,
  buildTakeSkip,
} from "~/schemas/util";

export const findOrCreateProduct = async (
  db: Prisma.TransactionClient,
  now: Date,
  product: ProductConfigItem,
) => {
  const { name, manufacturer, upc, model } = product;
  let ingredient = undefined;
  if (product.ingredient) {
    //  only link item if its an ingredient

    ingredient = await findOrCreateIngredient(db, product.name);
  }
  const pricePerMapping: z.infer<typeof unitMappingBase> | undefined =
    product.price_per !== undefined
      ? {
          a: { value: 1, unit: "each" },
          b: { value: product.price_per, unit: "dollar" },
          source: "config",
        }
      : undefined;
  const upsertFields: Prisma.ProductCreateInput = {
    name,
    manufacturer,
    upc,
    model,
    updatedAt: now,
    Ingredient: ingredient ? { connect: { id: ingredient.id } } : undefined,
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
  const mappings = [
    ...(product.unit_mappings ?? []),
    ...(pricePerMapping ? [pricePerMapping] : []),
  ];

  await db.productUnitMappings.createMany({
    data: mappings.map(
      (unitMapping): Prisma.ProductUnitMappingsCreateManyInput => ({
        productId: productRow.id,
        a: unitMapping.a,
        b: unitMapping.b,
        source: unitMapping.source,
      }),
    ),
  });

  return productRow;
};

export const loadProducts = async (
  db: Prisma.TransactionClient,
  data: ProductConfigItem[],
) => {
  const now = new Date();

  for (const product of data) {
    await findOrCreateProduct(db, now, product);
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
