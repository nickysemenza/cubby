import type { Entity } from "@cubby/schemas/entity";
import type { BrowserRoutedEntity } from "@cubby/schemas/entity-manifest";
import type { QueryKey } from "@tanstack/react-query";
import { entities, getSortableFields } from "~/entities/entities";
import type { useTRPC } from "~/integrations/trpc/react";
import { invalidatesFor } from "~/lib/query-keys";
import {
  type GeneratedBrowserCrudEntity,
  generatedBrowserCrudEntities,
} from "./generated/entity-routes.gen";

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
  entity: BrowserRoutedEntity;
  route: (typeof entities)[BrowserRoutedEntity]["routes"];
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

type ExecutableQueryOptions = {
  queryKey: QueryKey;
  queryFn?: (context: { queryKey: QueryKey }) => Promise<unknown>;
  [key: string]: unknown;
};

type ExecutableMutationOptions = {
  mutationFn?: (variables: unknown) => Promise<unknown>;
  [key: string]: unknown;
};

function kernelQueryOptions(
  api: Api,
  command: Record<string, unknown>,
  queryKey: QueryKey,
  project: (result: Record<string, unknown>) => unknown,
) {
  const options = api.entity.query.queryOptions(
    command as never,
  ) as unknown as ExecutableQueryOptions;
  const queryFn = options.queryFn;
  if (!queryFn) throw new Error("Entity query has no executable transport");
  return {
    ...options,
    queryKey,
    queryFn: async (context: { queryKey: QueryKey }) =>
      project((await queryFn(context)) as Record<string, unknown>),
  };
}

function kernelMutationOptions(
  api: Api,
  entity: StandardEntity,
  action: "create" | "update" | "delete",
  callbacks: unknown,
) {
  const options =
    api.entity.mutate.mutationOptions() as unknown as ExecutableMutationOptions;
  const mutationFn = options.mutationFn;
  if (!mutationFn)
    throw new Error("Entity mutation has no executable transport");
  return {
    ...options,
    ...(callbacks as Record<string, unknown>),
    mutationFn: async (variables: unknown) => {
      const input = variables as {
        id?: string;
        ids?: string[];
        data?: Record<string, unknown>;
      };
      const command =
        action === "create"
          ? { action, entity, data: variables as Record<string, unknown> }
          : action === "update"
            ? { action, entity, id: input.id, data: input.data }
            : { action, entity, ids: input.ids };
      const result = (await mutationFn(command)) as Record<string, unknown>;
      return action === "delete"
        ? { deleted: result.deleted, sideEffects: result.sideEffects }
        : result.item;
    },
  };
}

export const standardEntities = generatedBrowserCrudEntities;
type StandardEntity = GeneratedBrowserCrudEntity;

function standardContract(
  entity: StandardEntity,
  options?: {
    pickerSearch?: EntityQueryContract["pickerSearch"];
  },
): EntityContract {
  const { pickerSearch } = options ?? {};
  const invalidationKeys = invalidatesFor(entity);
  return {
    entity,
    route: entities[entity].routes,
    defaultSort: entities[entity].list?.defaultSort ?? "createdAt",
    sortableFields: getSortableFields(entity),
    canPreview: true,
    invalidationKeys,
    query: {
      list: (api, params) =>
        kernelQueryOptions(
          api,
          { action: "list", entity, ...params },
          [[entity, "list"], { input: params }],
          (result) => ({ items: result.items, meta: result.meta }),
        ),
      detail: (api, id) =>
        kernelQueryOptions(
          api,
          { action: "get", entity, id, missing: "error" },
          [[entity, "getByID"], { input: { id } }],
          (result) => result.item,
        ),
      ...(pickerSearch ? { pickerSearch } : {}),
    },
    mutation: {
      invalidationKeys,
      create: (api, callbacks) =>
        kernelMutationOptions(api, entity, "create", callbacks),
      update: (api, callbacks) =>
        kernelMutationOptions(api, entity, "update", callbacks),
      delete: (api, callbacks) =>
        kernelMutationOptions(api, entity, "delete", callbacks),
    },
  };
}

const standardEntityContracts = Object.fromEntries(
  standardEntities.map((entity) => [
    entity,
    standardContract(
      entity,
      entity === "product"
        ? {
            pickerSearch: (api, params) =>
              api.product.search.queryOptions(listParams(params)),
          }
        : undefined,
    ),
  ]),
) as Record<StandardEntity, EntityContract>;

const entityContracts = {
  ...standardEntityContracts,
  image: {
    entity: "image",
    route: entities.image.routes,
    defaultSort: entities.image.list?.defaultSort ?? "createdAt",
    sortableFields: getSortableFields("image"),
    canPreview: true,
    invalidationKeys: invalidatesFor("image"),
    query: {
      list: (api, params) => api.image.list.queryOptions(listParams(params)),
      detail: (api, id) => api.image.getByID.queryOptions({ id }),
    },
    mutation: {
      invalidationKeys: invalidatesFor("image"),
      delete: (api, input) => api.image.delete.mutationOptions(input),
    },
  },
  "usda-food": {
    entity: "usda-food",
    route: entities["usda-food"].routes,
    defaultSort: entities["usda-food"].list?.defaultSort ?? "description",
    sortableFields: getSortableFields("usda-food"),
    canPreview: true,
    invalidationKeys: invalidatesFor("usda-food"),
    query: {
      list: (api, params) => api.usda.list.queryOptions(listParams(params)),
      detail: (api, id) =>
        api.usda.getByID.queryOptions({ id: fdcIdFromParam(id) }),
    },
    mutation: {
      invalidationKeys: invalidatesFor("usda-food"),
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
    invalidationKeys: invalidatesFor("cookbook"),
    query: {
      list: (api) => api.recipe.listCookbooks.queryOptions(),
      detail: (api) => api.recipe.listCookbooks.queryOptions(),
    },
    mutation: {
      invalidationKeys: invalidatesFor("cookbook"),
    },
  },
} satisfies Record<BrowserRoutedEntity, EntityContract>;

export function getEntityContract(entity: Entity): EntityContract {
  if (!(entity in entityContracts)) {
    throw new Error(`Entity ${entity} has no browser contract`);
  }
  return entityContracts[entity as BrowserRoutedEntity];
}
