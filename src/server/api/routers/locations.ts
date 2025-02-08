import { z } from "zod";
import { publicProcedure, createTRPCRouter } from "../trpc";
import { type PrismaClient, type Prisma } from "@prisma/client";
import {
  createPaginatedResponseSchema,
  extractDbTimestampsFromDBRec,
  buildTakeSkip,
  IDInput,
  sortPaginationCombo,
} from "~/schemas/util";
import { type InfLocationConfig } from "~/server/config";
import {
  type InfLocation,
  infLocation,
  type LocationOut,
  type LocationOutWithParentChildren,
  locationOutWithParentChildren,
  locationType,
} from "~/schemas/locations";

export const loadLocations = async (
  db: PrismaClient,
  data: InfLocationConfig[],
) => {
  const now = new Date();
  const load = async (
    parent: Prisma.LocationCreateInput | null,
    children: InfLocationConfig[],
  ): Promise<void> => {
    for (const child of children) {
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
      await load(res, child.children ?? []);
    }
  };

  await load(null, data);

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
  };
}>;

const dbLocationToAPIWithChildren: (
  location: LocationDeepDB,
) => LocationOutWithParentChildren = (location) => {
  const { parent, children, ...restOfLocation } = location;

  return {
    parent: parent ? dbLocationToAPI(parent) : null,
    children: children.map(dbLocationToAPI),
    ...dbLocationToAPI(restOfLocation),
  };
};

const dbLocationToAPI: (
  location: Prisma.LocationGetPayload<object>,
) => LocationOut = (location) => {
  return {
    id: location.id,
    name: location.name,
    type: location.type,
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

const buildLocationWithChildren = (
  x: Prisma.LocationGetPayload<{
    include: {
      children: true;
      parent: true;
    };
  }>,
): InfLocation => {
  return {
    name: x.name,
    id: x.id,
    type: x.type,
    //@ts-expect-error WIP
    children: (x.children || []).map(buildLocationWithChildren),
    //@ts-expect-error WIP
    parent: x.parent ? buildLocationWithChildren(x.parent) : undefined,
    ...extractDbTimestampsFromDBRec(x),
  };
};

const makeTree = publicProcedure
  .output(z.array(infLocation))
  .query(async ({ ctx }) => {
    const res = await ctx.db.location.findMany({
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
  });

const list = publicProcedure
  .input(
    z
      .object({
        nameFilter: z.string().optional(),
        itemTypeFilter: locationType.optional(),
      })
      .merge(sortPaginationCombo),
  )
  .output(createPaginatedResponseSchema(locationOutWithParentChildren))
  .query(async ({ ctx, input }) => {
    const orderBy: Prisma.LocationOrderByWithAggregationInput = {
      createdAt:
        input.sort.orderBy === "createdAt" ? input.sort.direction : undefined,
      name: input.sort.orderBy === "name" ? input.sort.direction : undefined,
    };
    const where: Prisma.LocationWhereInput = {
      name:
        input.nameFilter != ""
          ? { search: input.nameFilter, mode: "insensitive" }
          : undefined,
      type: input.itemTypeFilter,
    };
    const res = await ctx.db.location.findMany({
      orderBy,
      where,
      ...buildTakeSkip(input.pagination),
      include: {
        parent: true,
        children: true,
      },
    });
    const totalCount = await ctx.db.location.count({ where });
    const items = res.map(dbLocationToAPIWithChildren);
    return {
      meta: {
        pageIndex: input.pagination.pageIndex,
        pageSize: items.length,
        totalCount,
        // totalPages: 1,
      },
      items,
    };
  });

const getByID = publicProcedure
  .meta({ description: "location with infiinte parent and 1 child" })

  .input(IDInput)
  .output(infLocation)
  .query(async ({ ctx, input }) => {
    const res = await ctx.db.location.findFirstOrThrow({
      where: {
        id: input.id,
      },
      include: {
        parent: recursiveLocationParent(10),
        children: true,
      },
    });

    return buildLocationWithChildren(res);
  });
const getLocationTypesCount = publicProcedure
  .output(z.record(locationType, z.number()))
  .query(async ({ ctx }) => {
    const types = await ctx.db.location.groupBy({
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
  });
export const locationRouter = createTRPCRouter({
  list,
  getByID,
  getLocationTypesCount,
  makeTree,
});
