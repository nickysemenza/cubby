import { type Prisma, PrismaClient } from "@prisma/client";
import { type Database } from "~/server/db";
import {
  type LocationOutWithParentChildren,
  type LocationOut,
  type InfLocation,
  locationType,
  LocationCreateInput,
  LocationUpdateInput,
} from "~/schemas/location";
import {
  type LocationId,
  type ProjectId,
  unsafeLocationId,
  unsafeProductId,
  unsafeInventoryId,
} from "~/schemas/identifiers";
import {
  type SortParams,
  type PaginationParams,
  buildTakeSkip,
} from "~/schemas/pagination";
import { extractDbTimestampsFromDBRec } from "~/schemas/common";
import { type InfLocationConfig } from "../../schemas/config";
import { findOrCreateProduct, findProductByName } from "./product";
import {
  formatSearchTerm,
  getSortDirection,
  withTransaction,
  getDb,
} from "~/server/repo/database-helpers";

// Helper to safely unwrap Database or use TransactionClient directly
const unwrapDb = (
  db: Database | Prisma.TransactionClient,
): PrismaClient | Prisma.TransactionClient => {
  // If it already has Prisma methods (TransactionClient), use it directly
  return "product" in db ? db : getDb(db);
};

// Create a new location
export const createLocation = async (
  db: Database | Prisma.TransactionClient,
  data: LocationCreateInput,
  projectId: ProjectId,
) => {
  // Create the location
  const location = await unwrapDb(db).location.create({
    data: {
      project: { connect: { id: projectId } },
      name: data.name,
      type: data.type,
      parent: data.parentId
        ? {
            connect: {
              id: data.parentId,
            },
          }
        : undefined,
    },
    include: {
      parent: true,
      children: true,
    },
  });

  // Associate images if provided
  if (data.pendingImageIds && data.pendingImageIds.length > 0) {
    // Create LocationImage records in batch
    await unwrapDb(db).locationImage.createMany({
      data: data.pendingImageIds.map((imageId) => ({
        locationId: location.id,
        imageId,
      })),
    });

    // Update all image statuses to UPLOADED in batch
    await unwrapDb(db).image.updateMany({
      where: { id: { in: data.pendingImageIds } },
      data: { status: "UPLOADED" },
    });
  }
  return getLocationById(db, unsafeLocationId(location.id), projectId);
};

// Update an existing location
export const updateLocation = async (
  db: Database,
  id: LocationId,
  projectId: ProjectId,
  data: LocationUpdateInput["data"],
) => {
  // Make sure we're not setting a location as its own parent
  if (data.parentId === id) {
    throw new Error("A location cannot be its own parent");
  }

  // Check if the new parent would create a circular reference
  if (data.parentId) {
    const potentialParent = await getDb(db).location.findUnique({
      where: { id: data.parentId },
      include: { parent: true },
    });

    // Walk up the parent chain to check for circular references
    let currentParent = potentialParent?.parent;
    while (currentParent) {
      if (currentParent.id === id) {
        throw new Error("Circular parent-child relationship detected");
      }
      currentParent = await getDb(db)
        .location.findUnique({
          where: { id: currentParent.id },
          include: { parent: true },
        })
        .then((loc) => loc?.parent || null);
    }
  }

  return await withTransaction(db, async (tx) => {
    // Update the location
    const location = await tx.location.update({
      where: { id, projectId },
      data: {
        name: data.name,
        type: data.type,
        parent:
          data.parentId !== undefined
            ? data.parentId
              ? { connect: { id: data.parentId } }
              : { disconnect: true }
            : undefined,
      },
      include: {
        parent: true,
        children: true,
      },
    });

    // Add new images
    if (data.pendingImageIds && data.pendingImageIds.length > 0) {
      // Create LocationImage records in batch
      await tx.locationImage.createMany({
        data: data.pendingImageIds.map((imageId) => ({
          locationId: location.id,
          imageId,
        })),
      });

      // Update all image statuses to UPLOADED in batch
      await tx.image.updateMany({
        where: { id: { in: data.pendingImageIds } },
        data: { status: "UPLOADED" },
      });
    }

    // Remove existing images
    if (data.removeImageIds && data.removeImageIds.length > 0) {
      await tx.locationImage.deleteMany({
        where: {
          locationId: location.id,
          imageId: {
            in: data.removeImageIds,
          },
        },
      });
    }

    return getLocationById(tx, unsafeLocationId(location.id), projectId);
  });
};

const upsertChild = async (
  db: Prisma.TransactionClient,
  now: Date,
  parent: { id: string } | null,
  child: InfLocationConfig,
  projectId: ProjectId,
) => {
  const res = await db.location.upsert({
    where: {
      projectId_name: {
        projectId: projectId,
        name: child.name,
      },
    },
    create: {
      project: { connect: { id: projectId } },
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
  projectId: ProjectId,
) => {
  const now = new Date();
  const loadRecursive = async (
    parent: { id: string } | null,
    children: InfLocationConfig[],
  ): Promise<void> => {
    for (const child of children) {
      const res = await upsertChild(db, now, parent, child, projectId);
      const productsAtLocation = [];
      for (const product of child.products ?? []) {
        const productRow = await findOrCreateProduct(
          db,
          now,
          product,
          projectId,
        );
        productsAtLocation.push(productRow);
      }
      for (const product of child.productReferences ?? []) {
        const productRow = await findProductByName(db, product.name);
        productsAtLocation.push(productRow);
      }

      await db.inventoryEntry.deleteMany({
        where: {
          locationId: res.id,
        },
      });
      await db.inventoryEntry.createMany({
        data: productsAtLocation.map((product) => ({
          projectId: projectId,
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
      projectId, // Filter by project to prevent deleting other projects' data
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
    images: { include: { image: true } };
  };
}>;

const dbLocationToAPIWithChildren: (
  location: LocationDeepDB,
) => LocationOutWithParentChildren = (location) => {
  const { parent, children, InventoryEntries, images, ...restOfLocation } =
    location;

  // Extract images from the join table records if they exist
  const locationImages = images ? images.map((li) => li.image) : [];

  return {
    ...dbLocationToAPI(restOfLocation),
    parent: parent ? dbLocationToAPI(parent) : null,
    children: children.map(dbLocationToAPI),
    images: locationImages,
    inventoryEntries: InventoryEntries.map((x) => {
      const { Product, ...rest } = x;
      return {
        ...rest,
        id: unsafeInventoryId(rest.id),
        locationId: unsafeLocationId(rest.locationId),
        productId: unsafeProductId(rest.productId),
        product: {
          ...Product,
          id: unsafeProductId(Product.id),
        },
      };
    }),
  };
};

const dbLocationToAPI: (
  location: Prisma.LocationGetPayload<object>,
) => LocationOut = (location) => {
  return {
    id: unsafeLocationId(location.id),
    lastBulkInventory: location.lastBulkInventory,
    name: location.name,
    type: locationType.parse(location.type),
    images: [], //todo: fix
    ...extractDbTimestampsFromDBRec(location),
  };
};

// Internal utility function for recursive location inclusion
function recursiveLocationInclude(
  level: number,
  includeType: "children" | "parent",
): Prisma.LocationFindManyArgs {
  if (level === 0) {
    return {
      include: {
        [includeType]: true,
        images: {
          include: {
            image: true,
          },
        },
      },
    };
  }
  return {
    include: {
      [includeType]: recursiveLocationInclude(level - 1, includeType),
      images: {
        include: {
          image: true,
        },
      },
    },
  };
}

type LocationWithParentChild = Prisma.LocationGetPayload<{
  include: {
    children: true;
    parent: true;
    images: { include: { image: true } };
  };
}>;
const buildLocationWithChildren = (
  x: LocationWithParentChild,
  excludeId?: string,
): InfLocation => {
  // Extract images if they exist
  const locationImages = x.images ? x.images.map((li) => li.image) : [];

  return {
    name: x.name,
    id: x.id as unknown as LocationId,
    lastBulkInventory: x.lastBulkInventory,
    type: locationType.parse(x.type),
    images: locationImages,
    children:
      x.children && x.children.length > 0
        ? x.children
            .filter((child) => child.id !== excludeId)
            .map((child) =>
              buildLocationWithChildren(
                child as LocationWithParentChild,
                excludeId,
              ),
            )
        : [],
    parent: x.parent
      ? buildLocationWithChildren(
          x.parent as LocationWithParentChild,
          excludeId,
        )
      : undefined,
    ...extractDbTimestampsFromDBRec(x),
  };
};
export const buildLocationTypeCount = async (
  db: Database,
  projectId: ProjectId,
) => {
  const types = await getDb(db).location.groupBy({
    by: ["type"],
    where: {
      projectId, // Filter by project
    },
    _count: {
      type: true,
    },
    orderBy: {
      _count: {
        type: "desc",
      },
    },
  });
  const present = Object.fromEntries(
    types.map((t) => [t.type, t._count.type] as const),
  ) as Record<string, number>;
  // Ensure all enum values are present with a default of 0
  const allKeys = (locationType.options ?? []) as readonly string[];
  const full = Object.fromEntries(
    allKeys.map((k) => [k, present[k] ?? 0] as const),
  );
  return full as Record<(typeof allKeys)[number], number>;
};
export const buildLocationTree = async (db: Database, projectId: ProjectId) => {
  const res = await getDb(db).location.findMany({
    include: {
      children: recursiveLocationInclude(10, "children"),
      parent: true,
      images: {
        include: {
          image: true,
        },
      },
    },
    where: {
      projectId, // Filter by project
      parentId: null,
    },
  });

  const tree: InfLocation[] = res.map((x) => {
    return buildLocationWithChildren(x);
  });
  return tree;
};

export const locationList = async (
  db: Database,
  projectId: ProjectId,
  name: string | undefined,
  itemType: string | undefined,
  sort: SortParams,
  pagination: PaginationParams,
) => {
  const orderBy: Prisma.LocationOrderByWithAggregationInput = {
    createdAt: getSortDirection(sort, "createdAt"),
    name: getSortDirection(sort, "name"),
    type: getSortDirection(sort, "type"),
    lastBulkInventory: getSortDirection(sort, "lastBulkInventory"),
  };
  const where: Prisma.LocationWhereInput = {
    projectId, // Filter by project
    name: formatSearchTerm(name),
    type: itemType,
  };

  // Define query parameters once to avoid duplication
  const findManyParams = {
    orderBy,
    where,
    ...buildTakeSkip(pagination),
    include: {
      parent: true,
      children: true,
      InventoryEntries: { include: { Product: true } },
      images: {
        include: {
          image: true,
        },
      },
    },
  };

  // Execute both queries in a single transaction for better performance
  const [results, totalCount] = await getDb(db).$transaction([
    getDb(db).location.findMany(findManyParams),
    getDb(db).location.count({ where }),
  ]);

  const items = results.map(dbLocationToAPIWithChildren);
  return { data: items, count: totalCount };
};

export const getLocationById = async (
  db: Database | Prisma.TransactionClient,
  id: LocationId,
  projectId: ProjectId,
) => {
  const res = await unwrapDb(db).location.findFirstOrThrow({
    where: {
      id,
      projectId, // Ensure location belongs to project
    },
    include: {
      parent: recursiveLocationInclude(10, "parent"),
      children: true,
      images: {
        include: {
          image: true,
        },
      },
      InventoryEntries: { include: { Product: true } },
    },
  });

  return buildLocationWithChildren(res, id);
};
