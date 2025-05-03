import { type PrismaClient, type Prisma } from "@prisma/client";
import {
  type LocationOutWithParentChildren,
  type LocationOut,
  type InfLocation,
  locationType,
} from "~/schemas/location";
import {
  type SortParams,
  type PaginationParams,
  buildTakeSkip,
  extractDbTimestampsFromDBRec,
} from "~/schemas/util";
import { type InfLocationConfig } from "../../schemas/config";
import { findOrCreateProduct } from "./product";

const upsertChild = async (
  db: Prisma.TransactionClient,
  now: Date,
  parent: Prisma.LocationCreateInput | null,
  child: InfLocationConfig,
) => {
  const res = await db.location.upsert({
    where: {
      name: child.name,
    },
    create: {
      name: child.name,
      type: child.type,
      updatedAt: now,
      parent: parent
        ? {
            connect: {
              id: parent.id,
            },
          }
        : undefined,
    },
    update: {
      name: child.name,
      type: child.type,
      updatedAt: now,
      parent: parent
        ? {
            connect: {
              id: parent.id,
            },
          }
        : undefined,
    },
  });
  return res;
};
export const loadLocations = async (
  db: Prisma.TransactionClient,
  data: InfLocationConfig[],
) => {
  const now = new Date();
  const loadRecursive = async (
    parent: Prisma.LocationCreateInput | null,
    children: InfLocationConfig[],
  ): Promise<void> => {
    for (const child of children) {
      const res = await upsertChild(db, now, parent, child);
      const productsAtLocation = [];
      for (const product of child.products ?? []) {
        const productRow = await findOrCreateProduct(db, now, product);
        productsAtLocation.push(productRow);
      }

      await db.inventoryEntry.deleteMany({
        where: {
          locationId: res.id,
        },
      });
      await db.inventoryEntry.createMany({
        data: productsAtLocation.map((product) => ({
          locationId: res.id,
          productId: product.id,
          amount: { value: 1, unit: "each" },
        })),
      });

      await loadRecursive(res, child.children ?? []);
    }
  };

  await loadRecursive(null, data);

  const stale = await db.location.findMany({
    where: {
      updatedAt: {
        not: now,
      },
    },
  });
  for (const s of stale) {
    await db.location.delete({
      where: {
        id: s.id,
      },
    });
  }
};

type LocationDeepDB = Prisma.LocationGetPayload<{
  include: {
    parent: true;
    children: true;
    InventoryEntries: { include: { Product: true } };
  };
}>;

const dbLocationToAPIWithChildren: (
  location: LocationDeepDB,
) => LocationOutWithParentChildren = (location) => {
  const { parent, children, InventoryEntries, ...restOfLocation } = location;

  return {
    parent: parent ? dbLocationToAPI(parent) : null,
    children: children.map(dbLocationToAPI),
    inventoryEntries: InventoryEntries.map((x) => {
      const { Product, ...rest } = x;
      return {
        ...rest,
        product: Product,
      };
    }),
    ...dbLocationToAPI(restOfLocation),
  };
};

const dbLocationToAPI: (
  location: Prisma.LocationGetPayload<object>,
) => LocationOut = (location) => {
  return {
    id: location.id,
    name: location.name,
    type: locationType.parse(location.type),
    ...extractDbTimestampsFromDBRec(location),
  };
};

function recursiveLocationChildren(level: number): Prisma.LocationFindManyArgs {
  if (level === 0) {
    return {
      include: {
        children: true,
      },
    };
  }
  return {
    include: {
      children: recursiveLocationChildren(level - 1),
    },
  };
}
function recursiveLocationParent(level: number): Prisma.LocationFindManyArgs {
  if (level === 0) {
    return {
      include: {
        parent: true,
      },
    };
  }
  return {
    include: {
      parent: recursiveLocationParent(level - 1),
    },
  };
}
type LocationWithParentChild = Prisma.LocationGetPayload<{
  include: {
    children: true;
    parent: true;
  };
}>;
const buildLocationWithChildren = (x: LocationWithParentChild, excludeId?: string): InfLocation => {
  return {
    name: x.name,
    id: x.id,
    type: locationType.parse(x.type),
    children:
      x.children && x.children.length > 0
        ? x.children
            .filter((child) => child.id !== excludeId)
            .map((child) =>
              buildLocationWithChildren(child as LocationWithParentChild, excludeId),
            )
        : undefined,
    parent: x.parent
      ? buildLocationWithChildren(x.parent as LocationWithParentChild, excludeId)
      : undefined,
    ...extractDbTimestampsFromDBRec(x),
  };
};
export const buildLocationTypeCount = async (db: PrismaClient) => {
  const types = await db.location.groupBy({
    by: ["type"],
    _count: {
      type: true,
    },
    orderBy: {
      _count: {
        type: "desc",
      },
    },
  });
  const res = Object.fromEntries(types.map((t) => [t.type, t._count.type]));
  return res;
};
export const buildLocationTree = async (db: PrismaClient) => {
  const res = await db.location.findMany({
    include: {
      children: recursiveLocationChildren(10),
      parent: true,
    },
    where: {
      parentId: null,
    },
  });

  const tree: InfLocation[] = res.map((x) => {
    return buildLocationWithChildren(x);
  });
  return tree;
};

export const locationList = async (
  db: PrismaClient,
  name: string | undefined,
  itemType: string | undefined,
  sort: SortParams,
  pagination: PaginationParams,
) => {
  const orderBy: Prisma.LocationOrderByWithAggregationInput = {
    createdAt: sort.orderBy === "createdAt" ? sort.direction : undefined,
    name: sort.orderBy === "name" ? sort.direction : undefined,
    type: sort.orderBy === "type" ? sort.direction : undefined,
  };
  const where: Prisma.LocationWhereInput = {
    name: name != "" ? { search: name, mode: "insensitive" } : undefined,
    type: itemType,
  };
  const res = await db.location.findMany({
    orderBy,
    where,
    ...buildTakeSkip(pagination),
    include: {
      parent: true,
      children: true,
      InventoryEntries: { include: { Product: true } },
    },
  });
  const totalCount = await db.location.count({ where });
  const items = res.map(dbLocationToAPIWithChildren);
  return { data: items, count: totalCount };
};

export const getLocationById = async (db: PrismaClient, id: string) => {
  const res = await db.location.findFirstOrThrow({
    where: {
      id,
    },
    include: {
      parent: recursiveLocationParent(10),
      children: true,
    },
  });

  return buildLocationWithChildren(res, id);
};
