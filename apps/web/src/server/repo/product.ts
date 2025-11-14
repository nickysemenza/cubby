import { type Database, type Transaction } from "~/server/db";
import { type ProductConfigItem } from "../../schemas/config";
import { findOrCreateIngredient } from "./ingredient";
import { type z } from "zod";
import {
  type SortParams,
  type PaginationParams,
  buildTakeSkip,
} from "~/schemas/pagination";
import { productWithIngredientAndInventoryAndMappingsOut } from "~/schemas/combo";
import { type unitMappingBase } from "~/schemas/unitmapping";
import { locationType } from "~/schemas/location";
import { foodLookupParam, FoodLookupParam } from "@recipehub/usda-schemas";
import {
  type ProductTopLevelOut,
  type ProductInputPayload,
  productTopLevelOut,
} from "~/schemas/product";
import {
  formatSearchTerm,
  getDb,
  unwrapDb,
  relations,
  buildOrderBy,
  insertAndReturn,
  updateAndReturn,
  extractImagesFromJoinTable,
  mapRelation,
  addProductSourceMetadata,
} from "~/server/repo/database-helpers";
import {
  type ProductId,
  type OrganizationId,
  unsafeLocationId,
} from "~/schemas/identifiers";
import {
  product,
  productUnitMappings,
  ingredient,
  inventoryEntry,
  location,
  image,
  productImage,
} from "~/server/db/schema";
import { eq, and, count, ilike, ne, inArray } from "drizzle-orm";

export const findProductByName = async (
  db: Database | Transaction,
  name: string,
): Promise<typeof product.$inferSelect> => {
  const p = await unwrapDb(db).query.product.findMany({
    where: ilike(product.name, name),
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
  db: Transaction,
  now: Date,
  productConfig: ProductConfigItem,
  organizationId: OrganizationId,
): Promise<typeof product.$inferSelect> => {
  const {
    name,
    manufacturer,
    upc,
    model,
    ndb_number,
    ingredient: ingredientConfig,
    aliases,
    price_per,
    unit_mappings,
  } = productConfig;

  let ingredientRef = undefined;
  if (ingredientConfig) {
    // only link item if its an ingredient
    ingredientRef = await findOrCreateIngredient(
      db,
      name,
      aliases,
      organizationId,
    );
  }

  const pricePerMapping: z.infer<typeof unitMappingBase> | undefined =
    price_per !== undefined
      ? {
          a: { value: 1, unit: "each" },
          b: { value: price_per, unit: "dollar" },
          source: "config",
        }
      : undefined;

  // Check if product exists
  const existing = await db.query.product.findFirst({
    where: and(
      eq(product.organizationId, organizationId),
      eq(product.name, name),
      eq(product.manufacturer, manufacturer),
    ),
  });

  let productRow: typeof product.$inferSelect;

  if (existing) {
    // Update existing product
    productRow = await updateAndReturn(
      db,
      product,
      {
        name,
        manufacturer,
        upc,
        ndb_number,
        model,
        updatedAt: now,
        ingredientId: ingredientRef?.id ?? null,
      },
      eq(product.id, existing.id),
    );
  } else {
    // Create new product
    productRow = await insertAndReturn(db, product, {
      organizationId: organizationId,
      name,
      manufacturer,
      upc,
      ndb_number,
      model,
      updatedAt: now,
      ingredientId: ingredientRef?.id ?? null,
    });
  }

  // Delete existing mappings and recreate
  await db
    .delete(productUnitMappings)
    .where(eq(productUnitMappings.productId, productRow.id));

  const mappings = [
    ...(unit_mappings ?? []),
    ...(pricePerMapping ? [pricePerMapping] : []),
  ];

  if (mappings.length > 0) {
    await db.insert(productUnitMappings).values(
      mappings.map((unitMapping) => ({
        productId: productRow.id,
        a: unitMapping.a,
        b: unitMapping.b,
        source: unitMapping.source,
      })),
    );
  }

  return productRow;
};

export const loadProducts = async (
  db: Transaction,
  data: ProductConfigItem[],
  organizationId: OrganizationId,
) => {
  const now = new Date();

  for (const productConfig of data) {
    await findOrCreateProduct(db, now, productConfig, organizationId);
  }

  const stale = await db.query.product.findMany({
    where: and(
      eq(product.organizationId, organizationId),
      ne(product.updatedAt, now),
    ),
  });
  console.log({ stale: stale.map((s) => s.id) });
};

// Type for deeply nested product query
type ProductDeepDB = typeof product.$inferSelect & {
  Ingredient: typeof ingredient.$inferSelect | null;
  unitMappings: Array<typeof productUnitMappings.$inferSelect>;
  InventoryEntry: Array<
    typeof inventoryEntry.$inferSelect & {
      location: typeof location.$inferSelect & {
        images: Array<{
          image: typeof image.$inferSelect;
        }>;
      };
    }
  >;
  images: Array<{
    image: typeof image.$inferSelect;
  }>;
};

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

  // Find all matching products
  const res = await getDb(db).query.product.findMany({
    where:
      lookup.kind === "upc"
        ? eq(product.upc, lookup.gtin_upc)
        : eq(product.ndb_number, lookup.ndb_number),
    ...relations.product.full,
  });

  return res.map((p) => ({
    ...p,
    images: p.images?.map((pi) => pi.image) ?? [],
  }));
};

const dbProductToAPI = async (
  db: Database,
  productData: ProductDeepDB,
): Promise<z.infer<typeof productWithIngredientAndInventoryAndMappingsOut>> => {
  const { Ingredient, unitMappings, InventoryEntry, images, ...restOfProduct } =
    productData;

  const result = {
    ...restOfProduct,
    ingredient: Ingredient,
    unitMappings: addProductSourceMetadata(productData.id, unitMappings),
    images: extractImagesFromJoinTable(images),
    inventoryEntry: mapRelation(InventoryEntry, (entry) => {
      const {
        type,
        images: locationImages,
        ...restOfLocation
      } = entry.location;

      return {
        ...entry,
        amount: entry.amount as { value: number; unit: string },
        location: {
          ...restOfLocation,
          id: unsafeLocationId(restOfLocation.id),
          type: locationType.parse(type),
          images: extractImagesFromJoinTable(locationImages),
        },
      };
    }),
  };

  // Use Zod parse to validate the transformation
  return productWithIngredientAndInventoryAndMappingsOut.parse(result);
};

export const getProductByID = async (
  db: Database,
  id: ProductId,
  organizationId: OrganizationId,
) => {
  const res = await getDb(db).query.product.findFirst({
    where: and(eq(product.id, id), eq(product.organizationId, organizationId)),
    ...relations.product.full,
  });

  if (!res) {
    throw new Error(`Product ${id} not found`);
  }

  return dbProductToAPI(db, res);
};

export const productList = async (
  db: Database,
  organizationId: OrganizationId,
  name: string | undefined,
  manufacturer: string | undefined,
  upc: string | undefined,
  sort: SortParams,
  pagination: PaginationParams,
) => {
  // Build where conditions
  const conditions = [eq(product.organizationId, organizationId)];

  if (name !== undefined) {
    const nameCondition = formatSearchTerm(product.name, name);
    if (nameCondition) {
      conditions.push(nameCondition);
    }
  }

  if (manufacturer !== undefined) {
    const manufacturerCondition = formatSearchTerm(
      product.manufacturer,
      manufacturer,
    );
    if (manufacturerCondition) {
      conditions.push(manufacturerCondition);
    }
  }

  if (upc !== undefined) {
    const upcCondition = formatSearchTerm(product.upc, upc);
    if (upcCondition) {
      conditions.push(upcCondition);
    }
  }

  const whereClause = and(...conditions);

  // Build order by
  const orderByArray = buildOrderBy(product, sort, [
    "createdAt",
    "name",
    "manufacturer",
    "model",
    "upc",
  ]);

  const { take, skip } = buildTakeSkip(pagination);

  // Execute queries
  const [results, [totalCountResult]] = await Promise.all([
    getDb(db).query.product.findMany({
      where: whereClause,
      orderBy: orderByArray,
      limit: take,
      offset: skip,
      ...relations.product.full,
    }),
    getDb(db).select({ count: count() }).from(product).where(whereClause),
  ]);

  const products = await Promise.all(
    results.map(async (prod: ProductDeepDB) => await dbProductToAPI(db, prod)),
  );

  return { data: products, count: totalCountResult?.count ?? 0 };
};

// Create a new product
export const createProduct = async (
  db: Database,
  data: ProductInputPayload,
  organizationId: OrganizationId,
): Promise<ProductTopLevelOut> => {
  const { ingredientId, unitMappings, pendingImageIds, ...productData } = data;

  // Use a transaction to ensure atomicity
  return await getDb(db).transaction(async (tx: Transaction) => {
    // Create the product first
    const [newProduct] = await tx
      .insert(product)
      .values({
        organizationId: organizationId,
        ...productData,
        ingredientId: ingredientId ?? null,
      })
      .returning();

    if (!newProduct) {
      throw new Error("Failed to create product");
    }

    // If there are unit mappings, create them
    if (unitMappings && unitMappings.length > 0) {
      await tx.insert(productUnitMappings).values(
        unitMappings.map((mapping) => ({
          productId: newProduct.id,
          a: mapping.a,
          b: mapping.b,
          source: mapping.source,
        })),
      );
    }

    // Associate images if provided
    let images: Array<typeof image.$inferSelect> = [];
    if (pendingImageIds && pendingImageIds.length > 0) {
      // Create ProductImage records in batch
      await tx.insert(productImage).values(
        pendingImageIds.map((imageId) => ({
          productId: newProduct.id,
          imageId,
        })),
      );

      // Update all image statuses to UPLOADED in batch
      await tx
        .update(image)
        .set({ status: "UPLOADED" })
        .where(inArray(image.id, pendingImageIds));

      // Fetch the associated images
      images = await tx
        .select()
        .from(image)
        .where(inArray(image.id, pendingImageIds));
    }

    // Construct and validate the response object
    const result = {
      ...newProduct,
      images,
    };

    return productTopLevelOut.parse(result);
  });
};

// Update an existing product
export const updateProduct = async (
  db: Database,
  id: ProductId,
  organizationId: OrganizationId,
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
  return await getDb(db).transaction(async (tx: Transaction) => {
    // Build update data
    const updateData: {
      name?: string;
      manufacturer?: string;
      upc?: string | null;
      ndb_number?: number | null;
      model?: string | null;
      expectedQuantity?: number | null;
      ingredientId?: string | null;
    } = { ...productData };

    // Handle ingredient relationship
    if (ingredientId !== undefined) {
      updateData.ingredientId = ingredientId;
    }

    // Update the product
    const updated = await updateAndReturn(
      tx,
      product,
      updateData,
      and(eq(product.id, id), eq(product.organizationId, organizationId)),
    );

    const productId = id;

    // If unitMappings is provided, handle the updates efficiently
    if (unitMappings !== undefined) {
      // Get existing mappings
      const existingMappings = await tx.query.productUnitMappings.findMany({
        where: eq(productUnitMappings.productId, productId),
      });

      // Find mappings to delete (exist in DB but not in new data)
      const toDelete = existingMappings.filter(
        (m: typeof productUnitMappings.$inferSelect) =>
          !unitMappings.some((um) => um.id === m.id),
      );

      // Find mappings to create (exist in new data but not in DB)
      const toCreate = unitMappings.filter(
        (m: (typeof unitMappings)[number]) => m.id === undefined,
      );

      // Find mappings to update (exist in both)
      const toUpdate = unitMappings.filter(
        (m): m is typeof m & { id: string } => m.id !== undefined,
      );

      // Delete removed mappings
      if (toDelete.length > 0) {
        await tx.delete(productUnitMappings).where(
          inArray(
            productUnitMappings.id,
            toDelete.map((m) => m.id),
          ),
        );
      }

      // Create new mappings
      if (toCreate.length > 0) {
        await tx.insert(productUnitMappings).values(
          toCreate.map((mapping) => ({
            productId,
            a: mapping.a,
            b: mapping.b,
            source: mapping.source,
          })),
        );
      }

      // Update existing mappings
      for (const mapping of toUpdate) {
        await tx
          .update(productUnitMappings)
          .set({
            a: mapping.a,
            b: mapping.b,
            source: mapping.source,
          })
          .where(eq(productUnitMappings.id, mapping.id));
      }
    }

    // Add new images if provided
    if (pendingImageIds && pendingImageIds.length > 0) {
      // Create ProductImage records in batch
      await tx.insert(productImage).values(
        pendingImageIds.map((imageId) => ({
          productId: updated.id,
          imageId,
        })),
      );

      // Update all image statuses to UPLOADED in batch
      await tx
        .update(image)
        .set({ status: "UPLOADED" })
        .where(inArray(image.id, pendingImageIds));
    }

    // Remove images if requested
    if (removeImageIds && removeImageIds.length > 0) {
      await tx
        .delete(productImage)
        .where(
          and(
            eq(productImage.productId, updated.id),
            inArray(productImage.imageId, removeImageIds),
          ),
        );
    }

    // Fetch all associated images
    const productImages = await tx.query.productImage.findMany({
      where: eq(productImage.productId, updated.id),
      with: {
        image: true,
      },
    });

    // Construct and validate the response object
    const result = {
      ...updated,
      images: productImages.map((pi) => pi.image),
    };

    return productTopLevelOut.parse(result);
  });
};

// Find products with expectedQuantity=1 that appear in multiple locations
export const findDuplicateUniqueProducts = async (
  db: Database,
  organizationId: OrganizationId,
) => {
  const duplicates = await getDb(db).query.product.findMany({
    where: and(
      eq(product.organizationId, organizationId),
      eq(product.expectedQuantity, 1),
    ),
    with: {
      InventoryEntry: {
        with: {
          location: true,
        },
      },
    },
  });

  return duplicates.filter((prod) => prod.InventoryEntry.length > 1);
};
