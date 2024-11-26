import { z } from "zod";
import { createTRPCRouter, publicProcedure } from "../trpc";
import { ItemType, type Prisma } from "@prisma/client";
import {
  createPaginatedResponseSchema,
  dbTimestamps,
  paginationParams,
  sortParams,
  buildTakeSkip,
} from "./util";
import { recipeTopLevel } from "../apiSchema";

type ItemDeepDBWithChildren = Prisma.ItemGetPayload<{
  include: {
    Product: true;
    Recipe: true;
    children: {
      include: {
        Product: true;
        Recipe: true;
        RecipeSectionIngredient: {
          include: {
            recipeSection: {
              include: {
                recipe: true;
              };
            };
          };
        };
      };
    };
    RecipeSectionIngredient: {
      include: {
        recipeSection: {
          include: {
            recipe: true;
          };
        };
      };
    };
  };
}>;
type ItemDeepDB = Prisma.ItemGetPayload<{
  include: {
    Product: true;
    Recipe: true;
    RecipeSectionIngredient: {
      include: {
        recipeSection: {
          include: {
            recipe: true;
          };
        };
      };
    };
  };
}>;

const dbItemToAPI: (item: ItemDeepDB) => ItemOut = (item) => {
  const { Product, Recipe, RecipeSectionIngredient, ...restOfItem } = item;

  return {
    ...restOfItem,
    recipe: Recipe,
    product: Product,
    appearsInRecipes: RecipeSectionIngredient.map(
      (section) => section.recipeSection.recipe,
    ),
  };
};
const dbItemToAPIWithChildren: (
  item: ItemDeepDBWithChildren,
) => ItemOutWithChldren = (item) => {
  const { children, ...restOfItem } = item;

  return {
    ...dbItemToAPI(restOfItem),
    children: children.map(dbItemToAPI),
  };
};

export type ItemOut = z.infer<typeof itemOut>;
export type ItemOutWithChldren = z.infer<typeof itemOutWithChildren>;
const itemOut = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    type: z.nativeEnum(ItemType),
    recipe: recipeTopLevel.nullable(),
    appearsInRecipes: z.array(recipeTopLevel),
    product: z.any().nullable(), //todo
  })
  .merge(dbTimestamps);
const itemOutWithChildren = z
  .object({ children: z.array(itemOut) })
  .merge(itemOut);

export const itemRouter = createTRPCRouter({
  getByName: publicProcedure
    .input(
      z.object({
        nameFilter: z.string(),
        itemTypeFilter: z.nativeEnum(ItemType).optional(),
      }),
    )
    .output(itemOut.nullable())
    .query(async ({ ctx, input }) => {
      const res = await ctx.db.item.findFirst({
        where: {
          name: { equals: input.nameFilter, mode: "insensitive" },
          type: input.itemTypeFilter,
        },
        include: {
          Product: true,
          Recipe: true,
          children: {
            include: {
              Product: true,
              Recipe: true,
              RecipeSectionIngredient: {
                include: {
                  recipeSection: {
                    include: {
                      recipe: true,
                    },
                  },
                },
              },
            },
          },
          RecipeSectionIngredient: {
            include: {
              recipeSection: {
                include: {
                  recipe: true,
                },
              },
            },
          },
        },
      });
      return res ? dbItemToAPI(res) : null;
    }),

  list: publicProcedure
    .input(
      z.object({
        sort: sortParams,
        pagination: paginationParams,
        nameFilter: z.string().optional(),
        itemTypeFilter: z.nativeEnum(ItemType).optional(),
      }),
    )
    .output(createPaginatedResponseSchema(itemOutWithChildren))
    .query(async ({ ctx, input }) => {
      const orderBy: Prisma.ItemOrderByWithAggregationInput = {
        createdAt:
          input.sort.orderBy === "createdAt" ? input.sort.direction : undefined,
        name: input.sort.orderBy === "name" ? input.sort.direction : undefined,
      };
      const where: Prisma.ItemWhereInput = {
        name:
          input.nameFilter != ""
            ? { search: input.nameFilter, mode: "insensitive" }
            : undefined,
        type: input.itemTypeFilter,
        parentItemId: null,
      };
      const res = await ctx.db.item.findMany({
        orderBy,
        where,
        ...buildTakeSkip(input.pagination),
        include: {
          Product: true,
          Recipe: true,
          children: {
            include: {
              Product: true,
              Recipe: true,
              RecipeSectionIngredient: {
                include: {
                  recipeSection: {
                    include: {
                      recipe: true,
                    },
                  },
                },
              },
            },
          },
          RecipeSectionIngredient: {
            include: {
              recipeSection: {
                include: {
                  recipe: true,
                },
              },
            },
          },
        },
      });
      const totalCount = await ctx.db.item.count({ where });
      const items = res.map(dbItemToAPIWithChildren);
      return {
        meta: {
          pageIndex: input.pagination.pageIndex,
          pageSize: items.length,
          totalCount,
          // totalPages: 1,
        },
        items,
      };
    }),
});
