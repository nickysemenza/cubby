import { type Prisma, type PrismaClient } from "@prisma/client";
import { type z } from "zod";
import {
  type SortParams,
  type PaginationParams,
  buildTakeSkip,
} from "~/schemas/util";
import { type inventoryWithLocationAndProductOut } from "~/schemas/combo";
import { locationType } from "~/schemas/location";

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
) => {
  const orderBy: Prisma.InventoryEntryOrderByWithAggregationInput = {
    createdAt: sort.orderBy === "createdAt" ? sort.direction : undefined,
    amount: sort.orderBy === "amount" ? sort.direction : undefined,
  };

  const where = undefined; // no filter support yet
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
