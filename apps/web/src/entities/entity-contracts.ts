import type { Entity } from "@cubby/schemas/entity";
import type { QueryKey } from "@tanstack/react-query";
import { skipToken } from "@tanstack/react-query";
import { entities } from "~/entities/entities";
import {
  ingredientAllMutationInvalidateKeys,
  inventoryMutationInvalidateKeys,
  locationMutationInvalidateKeys,
  mealMutationInvalidateKeys,
  productMutationInvalidateKeys,
  queryKeys,
  recipeAllMutationInvalidateKeys,
} from "~/lib/query-keys";
import type { useTRPC } from "~/trpc/react";

type Api = ReturnType<typeof useTRPC>;

type ListParams = {
  sort: { orderBy: string; direction: "asc" | "desc" };
  pagination: { pageIndex: number; pageSize: number };
  filters: unknown;
  groupBy?: string;
};

type QueryFactory = (api: Api, input: never) => unknown;

export interface EntityMutationContract {
  invalidationKeys: readonly QueryKey[];
  create?: QueryFactory;
  update?: QueryFactory;
  delete?: QueryFactory;
}

export interface EntityQueryContract {
  list?: (api: Api, params: ListParams) => unknown;
  detail?: (api: Api, id: string) => unknown;
  pickerSearch?: (api: Api, params: ListParams) => unknown;
}

export interface EntityContract {
  entity: Entity;
  route: (typeof entities)[Entity]["routes"];
  defaultSort: string;
  sortableFields: readonly string[];
  canPreview: boolean;
  invalidationKeys: readonly QueryKey[];
  query: EntityQueryContract;
  mutation: EntityMutationContract;
}

export const fdcIdFromParam = (id: string): number => Number.parseInt(id, 10);
export const usdaRouteId = (fdcId: number): string => String(fdcId);

const skippedDetailQuery = {
  queryKey: ["entity-skip"] as const,
  queryFn: skipToken,
};

const listParams = (params: ListParams) => params as never;

export const entityContracts = {
  product: {
    entity: "product",
    route: entities.product.routes,
    defaultSort: entities.product.list?.defaultSort ?? "createdAt",
    sortableFields: entities.product.list?.sortableFields ?? [],
    canPreview: true,
    invalidationKeys: productMutationInvalidateKeys,
    query: {
      list: (api, params) => api.product.list.queryOptions(listParams(params)),
      detail: (api, id) => api.product.getByID.queryOptions({ id }),
      pickerSearch: (api, params) =>
        api.product.search.queryOptions(listParams(params)),
    },
    mutation: {
      invalidationKeys: productMutationInvalidateKeys,
      create: (api, input) => api.product.create.mutationOptions(input),
      update: (api, input) => api.product.update.mutationOptions(input),
      delete: (api, input) => api.product.delete.mutationOptions(input),
    },
  },
  ingredient: {
    entity: "ingredient",
    route: entities.ingredient.routes,
    defaultSort: entities.ingredient.list?.defaultSort ?? "createdAt",
    sortableFields: entities.ingredient.list?.sortableFields ?? [],
    canPreview: true,
    invalidationKeys: ingredientAllMutationInvalidateKeys,
    query: {
      list: (api, params) =>
        api.ingredient.list.queryOptions(listParams(params)),
      detail: (api, id) => api.ingredient.getByID.queryOptions({ id }),
    },
    mutation: {
      invalidationKeys: ingredientAllMutationInvalidateKeys,
      create: (api, input) => api.ingredient.create.mutationOptions(input),
      update: (api, input) => api.ingredient.update.mutationOptions(input),
      delete: (api, input) => api.ingredient.delete.mutationOptions(input),
    },
  },
  inventory: {
    entity: "inventory",
    route: entities.inventory.routes,
    defaultSort: entities.inventory.list?.defaultSort ?? "createdAt",
    sortableFields: entities.inventory.list?.sortableFields ?? [],
    canPreview: true,
    invalidationKeys: inventoryMutationInvalidateKeys,
    query: {
      list: (api, params) =>
        api.inventory.list.queryOptions(listParams(params)),
      detail: (api, id) => api.inventory.getByID.queryOptions({ id }),
    },
    mutation: {
      invalidationKeys: inventoryMutationInvalidateKeys,
      create: (api, input) => api.inventory.create.mutationOptions(input),
      update: (api, input) => api.inventory.update.mutationOptions(input),
      delete: (api, input) => api.inventory.delete.mutationOptions(input),
    },
  },
  location: {
    entity: "location",
    route: entities.location.routes,
    defaultSort: entities.location.list?.defaultSort ?? "createdAt",
    sortableFields: entities.location.list?.sortableFields ?? [],
    canPreview: true,
    invalidationKeys: locationMutationInvalidateKeys,
    query: {
      list: (api, params) => api.location.list.queryOptions(listParams(params)),
      detail: (api, id) => api.location.getByID.queryOptions({ id }),
    },
    mutation: {
      invalidationKeys: locationMutationInvalidateKeys,
      create: (api, input) => api.location.create.mutationOptions(input),
      update: (api, input) => api.location.update.mutationOptions(input),
      delete: (api, input) => api.location.delete.mutationOptions(input),
    },
  },
  recipe: {
    entity: "recipe",
    route: entities.recipe.routes,
    defaultSort: entities.recipe.list?.defaultSort ?? "createdAt",
    sortableFields: entities.recipe.list?.sortableFields ?? [],
    canPreview: true,
    invalidationKeys: recipeAllMutationInvalidateKeys,
    query: {
      list: (api, params) => api.recipe.list.queryOptions(listParams(params)),
      detail: (api, id) => api.recipe.getByID.queryOptions({ id }),
    },
    mutation: {
      invalidationKeys: recipeAllMutationInvalidateKeys,
      create: (api, input) => api.recipe.create.mutationOptions(input),
      update: (api, input) => api.recipe.update.mutationOptions(input),
      delete: (api, input) => api.recipe.delete.mutationOptions(input),
    },
  },
  meal: {
    entity: "meal",
    route: entities.meal.routes,
    defaultSort: entities.meal.list?.defaultSort ?? "date",
    sortableFields: entities.meal.list?.sortableFields ?? [],
    canPreview: true,
    invalidationKeys: mealMutationInvalidateKeys,
    query: {
      list: (api, params) => api.meal.list.queryOptions(listParams(params)),
      detail: (api, id) => api.meal.getByID.queryOptions({ id }),
    },
    mutation: {
      invalidationKeys: mealMutationInvalidateKeys,
      create: (api, input) => api.meal.create.mutationOptions(input),
      update: (api, input) => api.meal.update.mutationOptions(input),
      delete: (api, input) => api.meal.delete.mutationOptions(input),
    },
  },
  image: {
    entity: "image",
    route: entities.image.routes,
    defaultSort: entities.image.list?.defaultSort ?? "createdAt",
    sortableFields: entities.image.list?.sortableFields ?? [],
    canPreview: true,
    invalidationKeys: [queryKeys.image.all],
    query: {
      list: (api, params) => api.image.list.queryOptions(listParams(params)),
      detail: (api, id) => api.image.getImageById.queryOptions({ id }),
    },
    mutation: {
      invalidationKeys: [queryKeys.image.all],
    },
  },
  "usda-food": {
    entity: "usda-food",
    route: entities["usda-food"].routes,
    defaultSort: entities["usda-food"].list?.defaultSort ?? "description",
    sortableFields: entities["usda-food"].list?.sortableFields ?? [],
    canPreview: true,
    invalidationKeys: [queryKeys.usda.all],
    query: {
      list: (api, params) => api.usda.list.queryOptions(listParams(params)),
      detail: (api, id) =>
        api.usda.getByID.queryOptions({ id: fdcIdFromParam(id) }),
    },
    mutation: {
      invalidationKeys: [queryKeys.usda.all],
    },
  },
  cookbook: {
    entity: "cookbook",
    route: entities.cookbook.routes,
    defaultSort: "title",
    sortableFields: [],
    canPreview: false,
    invalidationKeys: [queryKeys.cookbook.all],
    query: {
      list: (api) => api.recipe.listCookbooks.queryOptions(),
      detail: () => skippedDetailQuery,
    },
    mutation: {
      invalidationKeys: [queryKeys.cookbook.all],
    },
  },
} satisfies Record<Entity, EntityContract>;

export function getEntityContract(entity: Entity): EntityContract {
  return entityContracts[entity];
}
