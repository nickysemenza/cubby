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

const inventoryentryInclude = {
  Product: {
    include: {
      unitMappings: true,
    },
  },
  location: true,
};

type InventoryEntryDeepDB = Prisma.InventoryEntryGetPayload<{
  include: {
    Product: {
      include: {
        unitMappings: true;
      };
    };
    location: true;
  };
}>;

const dbInventoryEntryoToAPI: (
  inventoryentry: InventoryEntryDeepDB,
) => z.infer<typeof inventoryWithLocationAndProductOut> = (inventoryentry) => {
  const { Product, location, ...restOfIngredient } = inventoryentry;

  const { type, ...restOfLocation } = location;
  return {
    ...restOfIngredient,
    location: {
      ...restOfLocation,
      type: locationType.parse(type),
    },
    product: {
      ...Product,
      unitMappings: Product.unitMappings,
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

  return res ? dbInventoryEntryoToAPI(res) : null;
};

export const inventoryentryList = async (
  db: PrismaClient,
  sort: SortParams,
  pagination: PaginationParams,
  productNameFilter?: string,
  locationNameFilter?: string,
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
  };

  const res = await db.inventoryEntry.findMany({
    orderBy,
    where,
    ...buildTakeSkip(pagination),
    include: inventoryentryInclude,
  });
  const totalCount = await db.inventoryEntry.count({ where });
  const inventoryentrys = res.map(dbInventoryEntryoToAPI);
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

  return dbInventoryEntryoToAPI(updated);
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

  return dbInventoryEntryoToAPI(created);
};
