import { type Prisma, type PrismaClient } from "@prisma/client";
import { type z } from "zod";
import {
  type SortParams,
  type PaginationParams,
  buildTakeSkip,
} from "~/schemas/util";
import { type inventoryWithLocationAndProductOut } from "~/schemas/combo";
import { locationType } from "~/schemas/location";
import { getSortDirection } from "./util";
import { InventoryBulkOperationItem } from "~/schemas/inventory";

const inventoryentryInclude = {
  Product: {
    include: {
      unitMappings: true,
      images: {
        include: {
          image: true,
        },
      },
    },
  },
  location: {
    include: {
      images: {
        include: {
          image: true,
        },
      },
    },
  },
};

type InventoryEntryDeepDB = Prisma.InventoryEntryGetPayload<{
  include: {
    Product: {
      include: {
        unitMappings: true;
        images: {
          include: {
            image: true;
          };
        };
      };
    };
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
}>;

const dbInventoryEntryToAPI: (
  inventoryentry: InventoryEntryDeepDB,
) => z.infer<typeof inventoryWithLocationAndProductOut> = (inventoryentry) => {
  const { Product, location, ...restOfInventoryEntry } = inventoryentry;

  const { type, images: locationImages, ...restOfLocation } = location;

  // Extract images from join tables
  const productImages = Product.images
    ? Product.images.map((pi) => pi.image)
    : [];
  const extractedLocationImages = locationImages
    ? locationImages.map((li) => li.image)
    : [];

  return {
    ...restOfInventoryEntry,
    location: {
      ...restOfLocation,
      type: locationType.parse(type),
      images: extractedLocationImages,
    },
    product: {
      ...Product,
      unitMappings: Product.unitMappings,
      images: productImages,
    },
  };
};

export const getInventoryEntryByID = async (db: PrismaClient, id: string) => {
  const res = await db.inventoryEntry.findFirst({
    where: {
      id,
    },
    include: inventoryentryInclude,
  });

  return res ? dbInventoryEntryToAPI(res) : null;
};

export const inventoryentryList = async (
  db: PrismaClient,
  sort: SortParams,
  pagination: PaginationParams,
  productNameFilter?: string,
  locationNameFilter?: string,
  locationIdFilter?: string,
) => {
  const orderBy: Prisma.InventoryEntryOrderByWithAggregationInput = {
    createdAt: getSortDirection(sort, "createdAt"),
    amount: getSortDirection(sort, "amount"),
  };

  // Build where clause based on filters
  const where: Prisma.InventoryEntryWhereInput = {
    ...(productNameFilter
      ? {
          Product: {
            name: {
              contains: productNameFilter,
              mode: "insensitive",
            },
          },
        }
      : {}),
    ...(locationNameFilter
      ? {
          location: {
            name: {
              contains: locationNameFilter,
              mode: "insensitive",
            },
          },
        }
      : {}),
    ...(locationIdFilter
      ? {
          location: {
            id: locationIdFilter,
          },
        }
      : {}),
  };

  // Define query parameters once to avoid duplication
  const findManyParams = {
    orderBy,
    where,
    ...buildTakeSkip(pagination),
    include: inventoryentryInclude,
  };

  // Execute both queries in a single transaction for better performance
  const [results, totalCount] = await db.$transaction([
    db.inventoryEntry.findMany(findManyParams),
    db.inventoryEntry.count({ where }),
  ]);

  const inventoryentrys = results.map(dbInventoryEntryToAPI);
  return { data: inventoryentrys, count: totalCount };
};

export interface UpdateInventoryEntryData {
  amount?: z.infer<typeof import("~/codec/codec").amount>;
  productId?: string;
  locationId?: string;
}

export const updateInventoryEntry = async (
  db: PrismaClient,
  id: string,
  data: UpdateInventoryEntryData,
) => {
  const updated = await db.inventoryEntry.update({
    where: {
      id,
    },
    data: {
      ...(data.amount ? { amount: data.amount } : {}),
      ...(data.productId ? { productId: data.productId } : {}),
      ...(data.locationId ? { locationId: data.locationId } : {}),
    },
    include: inventoryentryInclude,
  });

  return dbInventoryEntryToAPI(updated);
};

export interface CreateInventoryEntryData {
  amount: z.infer<typeof import("~/codec/codec").amount>;
  productId: string;
  locationId: string;
}

export const createInventoryEntry = async (
  db: PrismaClient,
  data: CreateInventoryEntryData,
) => {
  const created = await db.inventoryEntry.create({
    data: {
      productId: data.productId,
      locationId: data.locationId,
      amount: data.amount,
    },
    include: inventoryentryInclude,
  });

  return dbInventoryEntryToAPI(created);
};

export const bulkProcessInventoryEntries = async (
  db: PrismaClient,
  locationId: string,
  items: InventoryBulkOperationItem[],
) => {
  // Use a transaction to ensure all operations are processed atomically
  const processedItems = await db.$transaction(async (tx) => {
    const results = [];

    // First, get all existing inventory entries for this location
    const existingItems = await tx.inventoryEntry.findMany({
      where: {
        locationId: locationId,
      },
      include: inventoryentryInclude,
    });

    // Get IDs of items in the submitted array
    const submittedIds = items.filter((item) => item.id).map((item) => item.id);

    // Find items to delete (existing items not in the submitted array)
    const itemsToDelete = existingItems.filter(
      (item) => !submittedIds.includes(item.id),
    );

    // Delete items that are not in the submitted array
    for (const item of itemsToDelete) {
      await tx.inventoryEntry.delete({
        where: { id: item.id },
      });
    }

    // Process submitted items - create new or update existing
    for (const item of items) {
      if (!item.id) {
        // Create new inventory entry - productId and amount are required
        if (!item.productId || !item.amount) {
          throw new Error("productId and amount are required for new items");
        }
        const created = await tx.inventoryEntry.create({
          data: {
            productId: item.productId,
            locationId: locationId,
            amount: item.amount,
          },
          include: inventoryentryInclude,
        });
        results.push(created);
      } else {
        // Update existing inventory entry
        const updateData: Prisma.InventoryEntryUpdateInput = {};
        if (item.amount) updateData.amount = item.amount;
        if (item.productId)
          updateData.Product = { connect: { id: item.productId } };

        // Only process if there are actual updates
        if (Object.keys(updateData).length > 0) {
          const updated = await tx.inventoryEntry.update({
            where: { id: item.id },
            data: updateData,
            include: inventoryentryInclude,
          });
          results.push(updated);
        } else {
          // If no updates, just fetch the current item
          const current = await tx.inventoryEntry.findUnique({
            where: { id: item.id },
            include: inventoryentryInclude,
          });
          if (current) results.push(current);
        }
      }
    }

    // Update the location's lastBulkInventory timestamp
    await tx.location.update({
      where: { id: locationId },
      data: { lastBulkInventory: new Date() },
    });

    return results;
  });

  return processedItems.map(dbInventoryEntryToAPI);
};
