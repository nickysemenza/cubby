import { Product, type Prisma, type PrismaClient } from "@prisma/client";
import { type ProductConfigItem } from "../../schemas/config";
import { findOrCreateIngredient } from "./ingredient";
import { type z } from "zod";
import {
  type SortParams,
  type PaginationParams,
  buildTakeSkip,
} from "~/schemas/util";
import { type productWithIngredientAndInventoryAndMappingsOut } from "~/schemas/combo";
import { type unitMappingBase } from "~/schemas/unitmapping";
import { locationType } from "~/schemas/location";
import { findFood } from "./usda";
import { foodLookupParam, FoodLookupParam } from "~/schemas/usda";
import { type productBase, type ProductTopLevelOut } from "~/schemas/product";
import { formatSearchTerm } from "./util";

export const findOrCreateProduct = async (
  db: Prisma.TransactionClient,
  now: Date,
  product: ProductConfigItem,
): Promise<Product> => {
  if (product.kind === "reference") {
    const p = await db.product.findMany({
      where: {
        name: {
          equals: product.name,
          mode: "insensitive",
        },
      },
    });

    switch (p.length) {
      case 0:
        throw new Error(`Product ${product.name} not found`);
      case 1:
        return p[0];
      default:
        throw new Error(
          `findOrCreateProduct: Product ${product.name} is ambiguous`,
        );
    }
  }
  const {
    name,
    manufacturer,
    upc,
    model,
    ndb_number,
    ingredient,
    price_per,
    unit_mappings,
  } = product.data;
  let ingredeintRef = undefined;
  if (ingredient) {
    //  only link item if its an ingredient

    ingredeintRef = await findOrCreateIngredient(db, name);
  }
  const pricePerMapping: z.infer<typeof unitMappingBase> | undefined =
    price_per !== undefined
      ? {
          a: { value: 1, unit: "each" },
          b: { value: price_per, unit: "dollar" },
          source: "config",
        }
      : undefined;
  const upsertFields: Prisma.ProductCreateInput = {
    name,
    manufacturer,
    upc,
    ndb_number,
    model,
    updatedAt: now,
    Ingredient: ingredeintRef
      ? { connect: { id: ingredeintRef.id } }
      : undefined,
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
    ...(unit_mappings ?? []),
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

const productInclude = {
  Ingredient: true,
  unitMappings: true,
  InventoryEntry: { include: { location: true } },
};

type ProductDeepDB = Prisma.ProductGetPayload<{
  include: {
    Ingredient: true;
    unitMappings: true;
    InventoryEntry: { include: { location: true } };
  };
}>;

// Convert product to food lookup parameter
export const foodLookupParamFromProduct = (product: {
  upc: string | null;
  ndb_number: number | null;
}): FoodLookupParam | null => {
  if (product.upc !== null) {
    return { kind: "upc", gtin_upc: product.upc };
  }
  if (product.ndb_number !== null) {
    return { kind: "ndb", ndb_number: product.ndb_number };
  }
  return null;
};

// Find products by UPC or NDB number - used to find linked products for food items
export const findProductsByFoodIdentifier = async (
  db: PrismaClient,
  rawLookup?: FoodLookupParam,
) => {
  if (!rawLookup) {
    return [];
  }
  // validate that lookup zod schema is good

  const lookup = foodLookupParam.parse(rawLookup);

  // Create where clause based on lookup type
  const where: Prisma.ProductWhereInput =
    lookup.kind === "upc"
      ? { upc: lookup.gtin_upc }
      : { ndb_number: lookup.ndb_number };

  // Find all matching products
  const res = await db.product.findMany({
    where,
  });
  return res;
};

const dbProductoToAPI: (
  db: PrismaClient,
  product: ProductDeepDB,
) => Promise<
  z.infer<typeof productWithIngredientAndInventoryAndMappingsOut>
> = async (db, product) => {
  const { Ingredient, unitMappings, InventoryEntry, ...restOfProduct } =
    product;

  const lookupParam = foodLookupParamFromProduct(product);
  const food = lookupParam ? await findFood(db, lookupParam) : null;
  return {
    ...restOfProduct,
    ingredient: Ingredient,
    unitMappings,
    food,
    inventoryEntry: InventoryEntry.map((entry) => ({
      ...entry,
      location: {
        ...entry.location,
        type: locationType.parse(entry.location.type),
      },
    })),
  };
};

export const getProductByID = async (db: PrismaClient, id: string) => {
  const res = await db.product.findFirstOrThrow({
    where: {
      id,
    },
    include: productInclude,
  });
  return dbProductoToAPI(db, res);
};

export const productList = async (
  db: PrismaClient,
  name: string | undefined,
  manufacturer: string | undefined,
  upc: string | undefined,
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
    name: formatSearchTerm(name),
    manufacturer: formatSearchTerm(manufacturer),
    upc: formatSearchTerm(upc),
  };
  const res = await db.product.findMany({
    orderBy,
    where,
    ...buildTakeSkip(pagination),
    include: productInclude,
  });
  const totalCount = await db.product.count({ where });
  const products = await Promise.all(
    res.map(async (product) => await dbProductoToAPI(db, product)),
  );
  return { data: products, count: totalCount };
};

// Create a new product
export const createProduct = async (
  db: PrismaClient,
  data: z.infer<typeof productBase>,
): Promise<ProductTopLevelOut> => {
  const product = await db.product.create({
    data: {
      name: data.name,
      manufacturer: data.manufacturer,
      model: data.model,
      upc: data.upc,
      ndb_number: data.ndb_number,
    },
  });

  return product;
};

// Update an existing product
export const updateProduct = async (
  db: PrismaClient,
  id: string,
  data: Partial<z.infer<typeof productBase>>,
): Promise<ProductTopLevelOut> => {
  const product = await db.product.update({
    where: { id },
    data,
  });

  return product;
};
