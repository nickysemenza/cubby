import { Product, type Prisma } from "@prisma/client";
import { type Database } from "~/server/db";
import { type ProductConfigItem } from "../../schemas/config";
import { findOrCreateIngredient } from "./ingredient";
import { type z } from "zod";
import {
  type SortParams,
  type PaginationParams,
  buildTakeSkip,
} from "~/schemas/pagination";
import { type productWithIngredientAndInventoryAndMappingsOut } from "~/schemas/combo";
import { type unitMappingBase } from "~/schemas/unitmapping";
import { locationType } from "~/schemas/location";
import { foodLookupParam, FoodLookupParam } from "@recipehub/usda-schemas";
import {
  type ProductTopLevelOut,
  type ProductInputPayload,
} from "~/schemas/product";
import { formatSearchTerm } from "~/server/repo/database-helpers";
import { getSortDirection } from "~/server/repo/database-helpers";
import { type ProductId, type ProjectId } from "~/schemas/identifiers";

export const findProductByName = async (
  db: Prisma.TransactionClient,
  name: string,
): Promise<Product> => {
  const p = await db.product.findMany({
    where: {
      name: {
        equals: name,
        mode: "insensitive",
      },
    },
  });

  switch (p.length) {
    case 0:
      throw new Error(`Product ${name} not found`);
    case 1:
      return p[0];
    default:
      throw new Error(`findProductByName: Product ${name} is ambiguous`);
  }
};
export const findOrCreateProduct = async (
  db: Prisma.TransactionClient,
  now: Date,
  product: ProductConfigItem,
  projectId: ProjectId,
): Promise<Product> => {
  const {
    name,
    manufacturer,
    upc,
    model,
    ndb_number,
    ingredient,
    aliases,
    price_per,
    unit_mappings,
  } = product;
  let ingredeintRef = undefined;
  if (ingredient) {
    //  only link item if its an ingredient

    ingredeintRef = await findOrCreateIngredient(db, name, aliases, projectId);
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
    project: { connect: { id: projectId } },
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
      projectId_name_manufacturer: {
        projectId: projectId,
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
  projectId: ProjectId,
) => {
  const now = new Date();

  for (const product of data) {
    await findOrCreateProduct(db, now, product, projectId);
  }

  const stale = await db.product.findMany({
    where: {
      projectId, // Filter by project
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
  InventoryEntry: {
    include: {
      location: {
        include: {
          images: {
            include: {
              image: true,
            },
          },
        },
      },
    },
  },
  images: { include: { image: true } },
};

type ProductDeepDB = Prisma.ProductGetPayload<{
  include: {
    Ingredient: true;
    unitMappings: true;
    InventoryEntry: {
      include: {
        location: {
          include: {
            images: {
              include: {
                image: true;
              };
            };
          };
        };
      };
    };
    images: { include: { image: true } };
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

// Function to find products by UPC or NDB number - used for food items in usda.ts
export const findProductsByFoodIdentifier = async (
  db: Database,
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

const dbProductToAPI: (
  db: Database,
  product: ProductDeepDB,
) => Promise<
  z.infer<typeof productWithIngredientAndInventoryAndMappingsOut>
> = async (db, product) => {
  const { Ingredient, unitMappings, InventoryEntry, images, ...restOfProduct } =
    product;

  // Extract images from the join table records
  const productImages = images.map((pi) => pi.image);

  return {
    ...restOfProduct,
    ingredient: Ingredient,
    unitMappings: unitMappings.map((mapping) => ({
      ...mapping,
      sourceMetadata: { type: "product" as const, productId: product.id },
    })),
    images: productImages,
    inventoryEntry: InventoryEntry.map((entry) => {
      const {
        type,
        images: locationImages,
        ...restOfLocation
      } = entry.location;
      // Extract images from the join table
      const extractedLocationImages = locationImages
        ? locationImages.map((li) => li.image)
        : [];

      return {
        ...entry,
        location: {
          ...restOfLocation,
          type: locationType.parse(type),
          images: extractedLocationImages,
        },
      };
    }),
  } as unknown as z.infer<
    typeof productWithIngredientAndInventoryAndMappingsOut
  >;
};

export const getProductByID = async (
  db: Database,
  id: ProductId,
  projectId: ProjectId,
) => {
  const res = await db.product.findFirstOrThrow({
    where: {
      id,
      projectId, // Ensure product belongs to project
    },
    include: productInclude,
  });
  return dbProductToAPI(db, res);
};

export const productList = async (
  db: Database,
  projectId: ProjectId,
  name: string | undefined,
  manufacturer: string | undefined,
  upc: string | undefined,
  sort: SortParams,
  pagination: PaginationParams,
) => {
  const orderBy: Prisma.ProductOrderByWithAggregationInput = {
    createdAt: getSortDirection(sort, "createdAt"),
    name: getSortDirection(sort, "name"),
    manufacturer: getSortDirection(sort, "manufacturer"),
    model: getSortDirection(sort, "model"),
    upc: getSortDirection(sort, "upc"),
  };
  const where: Prisma.ProductWhereInput = {
    projectId, // Filter by project
    name: formatSearchTerm(name),
    manufacturer: formatSearchTerm(manufacturer),
    upc: formatSearchTerm(upc),
  };

  // Define query parameters once to avoid duplication
  const findManyParams = {
    orderBy,
    where,
    ...buildTakeSkip(pagination),
    include: productInclude,
  };

  // Execute both queries in a single transaction for better performance
  const [results, totalCount] = await db.$transaction([
    db.product.findMany(findManyParams),
    db.product.count({ where }),
  ]);

  const products = await Promise.all(
    results.map(async (product) => await dbProductToAPI(db, product)),
  );
  return { data: products, count: totalCount };
};

// Create a new product
export const createProduct = async (
  db: Database,
  data: ProductInputPayload,
  projectId: ProjectId,
): Promise<ProductTopLevelOut> => {
  const { ingredientId, unitMappings, pendingImageIds, ...productData } = data;

  // Use a transaction to ensure atomicity
  return await db.$transaction(async (tx) => {
    // Create the product first
    const product = await tx.product.create({
      data: {
        project: { connect: { id: projectId } },
        ...productData,
        Ingredient: ingredientId
          ? { connect: { id: ingredientId } }
          : undefined,
      },
    });

    // If there are unit mappings, create them
    if (unitMappings) {
      await tx.productUnitMappings.createMany({
        data: unitMappings.map((mapping) => ({
          productId: product.id,
          a: mapping.a,
          b: mapping.b,
          source: mapping.source,
        })),
      });
    }

    // Associate images if provided
    if (pendingImageIds && pendingImageIds.length > 0) {
      // Create ProductImage records in batch
      await tx.productImage.createMany({
        data: pendingImageIds.map((imageId) => ({
          productId: product.id,
          imageId,
        })),
      });

      // Update all image statuses to UPLOADED in batch
      await tx.image.updateMany({
        where: { id: { in: pendingImageIds } },
        data: { status: "UPLOADED" },
      });
    }

    return product as unknown as ProductTopLevelOut;
  });
};

// Update an existing product
export const updateProduct = async (
  db: Database,
  id: ProductId,
  projectId: ProjectId,
  data: Partial<ProductInputPayload>,
): Promise<ProductTopLevelOut> => {
  const {
    ingredientId,
    unitMappings,
    pendingImageIds,
    removeImageIds,
    ...productData
  } = data;

  // Use a transaction to ensure atomicity
  return await db.$transaction(async (tx) => {
    // Create the update data with relation handling
    const updateData: Prisma.ProductUpdateInput = {
      ...productData,
    };

    // Handle ingredient relationship
    if (ingredientId !== undefined) {
      if (ingredientId === null) {
        // Disconnect the ingredient if set to null
        updateData.Ingredient = { disconnect: true };
      } else {
        // Connect to the ingredient if ID is provided
        updateData.Ingredient = { connect: { id: ingredientId } };
      }
    }

    // Update the product
    const product = await tx.product.update({
      where: { id, projectId }, // Ensure product belongs to project
      data: updateData,
    });

    const productId = id;
    // If unitMappings is provided, handle the updates efficiently
    if (unitMappings !== undefined) {
      // Get existing mappings
      const existingMappings = await tx.productUnitMappings.findMany({
        where: { productId },
      });

      // Find mappings to delete (exist in DB but not in new data)
      const toDelete = existingMappings.filter(
        (m) => !unitMappings.some((um) => um.id === m.id),
      );

      // Find mappings to create (exist in new data but not in DB)
      const toCreate = unitMappings.filter((m) => m.id === undefined);

      // Find mappings to update (exist in both)
      const toUpdate = unitMappings.filter(
        (m): m is typeof m & { id: string } => m.id !== undefined,
      );

      // Delete removed mappings
      if (toDelete.length > 0) {
        await tx.productUnitMappings.deleteMany({
          where: {
            id: { in: toDelete.map((m) => m.id) },
          },
        });
      }

      // Create new mappings
      if (toCreate.length > 0) {
        await tx.productUnitMappings.createMany({
          data: toCreate.map((mapping) => ({
            productId,
            a: mapping.a,
            b: mapping.b,
            source: mapping.source,
          })),
        });
      }

      // Update existing mappings
      for (const mapping of toUpdate) {
        await tx.productUnitMappings.update({
          where: { id: mapping.id },
          data: {
            a: mapping.a,
            b: mapping.b,
            source: mapping.source,
          },
        });
      }
    }

    // Add new images if provided
    if (pendingImageIds && pendingImageIds.length > 0) {
      // Create ProductImage records in batch
      await tx.productImage.createMany({
        data: pendingImageIds.map((imageId) => ({
          productId: product.id,
          imageId,
        })),
      });

      // Update all image statuses to UPLOADED in batch
      await tx.image.updateMany({
        where: { id: { in: pendingImageIds } },
        data: { status: "UPLOADED" },
      });
    }

    // Remove images if requested
    if (removeImageIds && removeImageIds.length > 0) {
      await tx.productImage.deleteMany({
        where: {
          productId: product.id,
          imageId: {
            in: removeImageIds,
          },
        },
      });
    }

    return product as unknown as ProductTopLevelOut;
  });
};

// Find products with expectedQuantity=1 that appear in multiple locations
export const findDuplicateUniqueProducts = async (
  db: Database,
  projectId: ProjectId,
) => {
  const duplicates = await db.product.findMany({
    where: {
      projectId,
      expectedQuantity: 1,
    },
    include: {
      InventoryEntry: {
        include: {
          location: true,
        },
      },
    },
  });
  return duplicates.filter((product) => product.InventoryEntry.length > 1);
};
