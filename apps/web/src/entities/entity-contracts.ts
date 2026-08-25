import type { MutationSideEffects } from "@cubby/schemas/background-jobs";
import type { Entity } from "@cubby/schemas/entity";
import type { BrowserRoutedEntity } from "@cubby/schemas/entity-manifest";
import type { QueryKey, UseMutationOptions } from "@tanstack/react-query";
import type { z } from "zod";
import type { useTRPC } from "~/integrations/trpc/react";
import { invalidatesFor } from "~/lib/query-keys";
import type { entityBrowserMutationCommandSchema } from "~/server/entity-kernel/contracts";
import { entityDetailQueryOptions } from "./entity-detail";
import { entityListQueryOptions } from "./entity-list";
import { entityMutationOptions } from "./entity-mutation";
import type { EntityDetailByEntity } from "./generated/entity-details.gen";
import {
  type GeneratedBrowserCrudEntity,
  generatedBrowserCrudEntities,
} from "./generated/entity-routes.gen";

type Api = ReturnType<typeof useTRPC>;

type ListParams = {
  sort:
    | { orderBy: string; direction: "asc" | "desc" }
    | Array<{ orderBy: string; direction: "asc" | "desc" }>;
  pagination: { pageIndex: number; pageSize: number };
  filters: Record<string, unknown>;
  groupBy?: string;
};

type QueryFactory = (api: Api, input: never) => unknown;

interface EntityMutationContract {
  create?: QueryFactory;
  update?: QueryFactory;
  delete?: QueryFactory;
}

interface EntityQueryContract {
  list?: (api: Api, params: ListParams) => unknown;
  detail?: (api: Api, id: string) => unknown;
}

interface EntityContract {
  canPreview: boolean;
  invalidationKeys: readonly QueryKey[];
  query: EntityQueryContract;
  mutation: EntityMutationContract;
}

export const fdcIdFromParam = (id: string): number => Number.parseInt(id, 10);
export const usdaRouteId = (fdcId: number): string => String(fdcId);
const listParams = (params: ListParams) => params as never;

type ExecutableMutationOptions = {
  mutationFn?: (variables: unknown) => Promise<unknown>;
  [key: string]: unknown;
};

function kernelMutationOptions(
  entity: StandardEntity,
  action: "create" | "update" | "delete",
  callbacks: unknown,
) {
  const options =
    entityMutationOptions() as unknown as ExecutableMutationOptions;
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
        : {
            ...(result.item as Record<string, unknown>),
            sideEffects: result.sideEffects,
          };
    },
  };
}

const standardEntities = generatedBrowserCrudEntities;
type StandardEntity = GeneratedBrowserCrudEntity;

type StandardAction = "create" | "update" | "delete";
type CommandFor<
  E extends StandardEntity,
  A extends Exclude<StandardAction, "delete">,
> = Extract<
  z.input<typeof entityBrowserMutationCommandSchema>,
  { entity: E; action: A }
>;
type VariablesFor<
  E extends StandardEntity,
  A extends StandardAction,
> = A extends "create"
  ? CommandFor<E, "create"> extends { data: infer Data }
    ? Data
    : never
  : A extends "update"
    ? CommandFor<E, "update"> extends { id: infer Id; data: infer Data }
      ? { id: Id; data: Data }
      : never
    : { ids: string[] };
type MutationDataFor<
  E extends StandardEntity,
  A extends StandardAction,
> = A extends "delete"
  ? { deleted: number; sideEffects: MutationSideEffects }
  : EntityDetailByEntity[E] & { sideEffects: MutationSideEffects };

/** Start-backed replacement for a named tRPC CRUD `mutationOptions` factory. */
export function entityMutationOptionsFactory<
  E extends StandardEntity,
  A extends StandardAction,
>(entity: E, action: A) {
  return (
    callbacks: Omit<
      UseMutationOptions<MutationDataFor<E, A>, Error, VariablesFor<E, A>>,
      "mutationFn" | "mutationKey"
    > = {},
  ) =>
    kernelMutationOptions(
      entity,
      action,
      callbacks,
    ) as unknown as UseMutationOptions<
      MutationDataFor<E, A>,
      Error,
      VariablesFor<E, A>
    >;
}

function standardContract(entity: StandardEntity): EntityContract {
  const invalidationKeys = invalidatesFor(entity);
  return {
    canPreview: true,
    invalidationKeys,
    query: {
      list: (_api, params) => entityListQueryOptions(entity, params),
      detail: (_api, id) => entityDetailQueryOptions(entity, id),
    },
    mutation: {
      create: (_api, callbacks) =>
        kernelMutationOptions(entity, "create", callbacks),
      update: (_api, callbacks) =>
        kernelMutationOptions(entity, "update", callbacks),
      delete: (_api, callbacks) =>
        kernelMutationOptions(entity, "delete", callbacks),
    },
  };
}

const standardEntityContracts = Object.fromEntries(
  standardEntities.map((entity) => [entity, standardContract(entity)]),
) as Record<StandardEntity, EntityContract>;

const entityContracts = {
  ...standardEntityContracts,
  image: {
    canPreview: true,
    invalidationKeys: invalidatesFor("image"),
    query: {
      list: (api, params) => api.image.list.queryOptions(listParams(params)),
      detail: (api, id) => api.image.getByID.queryOptions({ id }),
    },
    mutation: {
      delete: (api, input) => api.image.delete.mutationOptions(input),
    },
  },
  "usda-food": {
    canPreview: true,
    invalidationKeys: invalidatesFor("usda-food"),
    query: {
      list: (api, params) => api.usda.list.queryOptions(listParams(params)),
      detail: (api, id) =>
        api.usda.getByID.queryOptions({ id: fdcIdFromParam(id) }),
    },
    mutation: {},
  },
  cookbook: {
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
    mutation: {},
  },
} satisfies Record<BrowserRoutedEntity, EntityContract>;

export function getEntityContract(entity: Entity): EntityContract {
  if (!(entity in entityContracts)) {
    throw new Error(`Entity ${entity} has no browser contract`);
  }
  return entityContracts[entity as BrowserRoutedEntity];
}
