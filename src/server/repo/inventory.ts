import { type Prisma, type PrismaClient } from "@prisma/client";
import { type z } from "zod";
import {
  type SortParams,
  type PaginationParams,
  buildTakeSkip,
} from "~/schemas/util";
import { type inventoryWithLocationAndProductOut } from "~/schemas/combo";

const inventoryentryInclude = {
  Product: true,
  location: true,
};

type InventoryEntryDeepDB = Prisma.InventoryEntryGetPayload<{
  include: {
    Product: true;
    location: true;
  };
}>;

const dbInventoryEntryoToAPI: (
  inventoryentry: InventoryEntryDeepDB,
) => z.infer<typeof inventoryWithLocationAndProductOut> = (inventoryentry) => {
  const { Product, location, ...restOfIngredient } = inventoryentry;

  return {
    ...restOfIngredient,
    location,
    product: Product,
  };
};

export const getInventoryEntryByID = async (db: PrismaClient, id: string) => {
  const res = await db.inventoryEntry.findFirstOrThrow({
    where: {
      id,
    },
    include: inventoryentryInclude,
  });
  return dbInventoryEntryoToAPI(res);
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
