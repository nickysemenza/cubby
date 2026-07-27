import type { Entity } from "@cubby/schemas/entity";
import type { QueryKey } from "@tanstack/react-query";
import { entities } from "~/entities/entities";
import type { useTRPC } from "~/integrations/trpc/react";
import {
  ingredientAllMutationInvalidateKeys,
  inventoryMutationInvalidateKeys,
  locationMutationInvalidateKeys,
  mealMutationInvalidateKeys,
  productMutationInvalidateKeys,
  projectMutationInvalidateKeys,
  purchaseMutationInvalidateKeys,
  queryKeys,
  recipeAllMutationInvalidateKeys,
  taskMutationInvalidateKeys,
} from "~/lib/query-keys";

type Api = ReturnType<typeof useTRPC>;

type ListParams = {
  sort: { orderBy: string; direction: "asc" | "desc" };
  pagination: { pageIndex: number; pageSize: number };
  filters: unknown;
  groupBy?: string;
};

type QueryFactory = (api: Api, input: never) => unknown;

interface EntityMutationContract {
  invalidationKeys: readonly QueryKey[];
  create?: QueryFactory;
  update?: QueryFactory;
  delete?: QueryFactory;
}

interface EntityQueryContract {
  list?: (api: Api, params: ListParams) => unknown;
  detail?: (api: Api, id: string) => unknown;
  pickerSearch?: (api: Api, params: ListParams) => unknown;
}

interface EntityContract {
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

const listParams = (params: ListParams) => params as never;

// The 9 core entities share a mechanically-identical contract whose only axes are
// the router key (== entity key), the invalidation-key list, and (product only) a
// picker-search query. image / usda-food / cookbook genuinely diverge (different
// router keys, fdc_id coercion, list-backed detail) and stay spelled out below.
export const standardEntities = [
  "product",
  "ingredient",
  "inventory",
  "location",
  "recipe",
  "meal",
  "project",
  "task",
  "purchase",
] as const;
type StandardEntity = (typeof standardEntities)[number];

// Indexing `api[entity]` yields a union of router proxies whose per-proc input
// types differ, so the method calls aren't callable as a union. The contract
// already erases those input/output types (QueryFactory takes `never`, returns
// `unknown`), so we project the router through this minimal structural view.
type StandardRouter = {
  list: { queryOptions: (input: never) => unknown };
  getByID: { queryOptions: (input: never) => unknown };
  create: { mutationOptions: (input: never) => unknown };
  update: { mutationOptions: (input: never) => unknown };
  delete: { mutationOptions: (input: never) => unknown };
};

function standardContract(
  entity: StandardEntity,
  invalidationKeys: readonly QueryKey[],
  pickerSearch?: EntityQueryContract["pickerSearch"],
): EntityContract {
  const router = (api: Api): StandardRouter =>
    api[entity] as unknown as StandardRouter;
  return {
    entity,
    route: entities[entity].routes,
    defaultSort: entities[entity].list?.defaultSort ?? "createdAt",
    sortableFields: entities[entity].list?.sortableFields ?? [],
    canPreview: true,
    invalidationKeys,
    query: {
      list: (api, params) => router(api).list.queryOptions(listParams(params)),
      detail: (api, id) => router(api).getByID.queryOptions({ id } as never),
      ...(pickerSearch ? { pickerSearch } : {}),
    },
    mutation: {
      invalidationKeys,
      create: (api, input) => router(api).create.mutationOptions(input),
      update: (api, input) => router(api).update.mutationOptions(input),
      delete: (api, input) => router(api).delete.mutationOptions(input),
    },
  };
}

const entityContracts = {
  product: standardContract(
    "product",
    productMutationInvalidateKeys,
    (api, params) => api.product.search.queryOptions(listParams(params)),
  ),
  ingredient: standardContract(
    "ingredient",
    ingredientAllMutationInvalidateKeys,
  ),
  inventory: standardContract("inventory", inventoryMutationInvalidateKeys),
  location: standardContract("location", locationMutationInvalidateKeys),
  recipe: standardContract("recipe", recipeAllMutationInvalidateKeys),
  meal: standardContract("meal", mealMutationInvalidateKeys),
  image: {
    entity: "image",
    route: entities.image.routes,
    defaultSort: entities.image.list?.defaultSort ?? "createdAt",
    sortableFields: entities.image.list?.sortableFields ?? [],
    canPreview: true,
    invalidationKeys: [queryKeys.image.all],
    query: {
      list: (api, params) => api.image.list.queryOptions(listParams(params)),
      detail: (api, id) => api.image.getByID.queryOptions({ id }),
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
    // Cookbooks are searchable, so a search-result row must open a preview
    // rather than a dead click. There is no cookbook getByID — the browse index
    // carries every field the preview needs, so `detail` warms that same query
    // and the panel's cookbook arm reads it (like the meal arm).
    canPreview: true,
    invalidationKeys: [queryKeys.cookbook.all],
    query: {
      list: (api) => api.recipe.listCookbooks.queryOptions(),
      detail: (api) => api.recipe.listCookbooks.queryOptions(),
    },
    mutation: {
      invalidationKeys: [queryKeys.cookbook.all],
    },
  },
  project: standardContract("project", projectMutationInvalidateKeys),
  task: standardContract("task", taskMutationInvalidateKeys),
  purchase: standardContract("purchase", purchaseMutationInvalidateKeys),
} satisfies Record<Entity, EntityContract>;

export function getEntityContract(entity: Entity): EntityContract {
  return entityContracts[entity];
}
