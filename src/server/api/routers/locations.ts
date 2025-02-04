import { z } from "zod";
import { publicProcedure, createTRPCRouter } from "../trpc";
import { type Prisma } from "@prisma/client";
import {
  createPaginatedResponseSchema,
  dbTimestamps,
  extractDbTimestampsFromDBRec,
  paginationParams,
  buildTakeSkip,
  sortParams,
} from "./util";

const locationType = z.string();
const locationOut = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    type: locationType,
  })
  .merge(dbTimestamps);
const locationOutWithParentChildren = z
  .object({
    children: z.array(locationOut),
    parent: locationOut.nullable(),
  })
  .merge(locationOut);

type InfLocation = z.infer<typeof locationOut> & {
  children: InfLocation[];
};

const infLocation: z.ZodType<InfLocation> = locationOut.extend({
  children: z.lazy(() => infLocation.array()),
});

export type LocationOutWithParentChildren = z.infer<
  typeof locationOutWithParentChildren
>;
export type LocationOut = z.infer<typeof locationOut>;

const foo = {
  parent: true,
  children: true,
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

const makeTree = publicProcedure
  .output(z.array(infLocation))
  .query(async ({ ctx }) => {
    const res = await ctx.db.location.findMany({
      include: {
        children: recursiveLocationChildren(10),
      },
      where: {
        parentId: null,
      },
    });
    const foo = (x: (typeof res)[0]): InfLocation => {
      return {
        name: x.name,
        id: x.id,
        type: x.type,
        //@ts-expect-error WIP
        children: x.children.map(foo),
        ...extractDbTimestampsFromDBRec(x),
      };
    };

    const tree: InfLocation[] = res.map((x) => {
      return foo(x);
    });
    return tree;
  });

const list = publicProcedure
  .input(
    z.object({
      sort: sortParams,
      pagination: paginationParams,
      nameFilter: z.string().optional(),
      itemTypeFilter: locationType.optional(),
    }),
  )
  .output(createPaginatedResponseSchema(locationOutWithParentChildren))
  .query(async ({ ctx, input }) => {
    const orderBy: Prisma.ItemOrderByWithAggregationInput = {
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
      // parentItemId: null,
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
  .input(
    z.object({
      id: z.string(),
    }),
  )
  .output(locationOutWithParentChildren)
  .query(async ({ ctx, input }) => {
    const res = await ctx.db.location.findFirstOrThrow({
      where: {
        id: input.id,
      },
      include: foo,
    });

    return dbLocationToAPIWithChildren(res);
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
