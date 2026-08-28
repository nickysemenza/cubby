import type { MutationSideEffects } from "@cubby/schemas/background-jobs";
import type { UseMutationOptions } from "@tanstack/react-query";
import type { z } from "zod";

import { entityRipple } from "~/integrations/tanstack-query/cache-tags";
import type { CubbyOperationMeta } from "~/integrations/tanstack-query/operation-meta";
import {
  entityBrowserMutationCommandSchema,
  type EntityBrowserMutationInput,
  EntityBrowserMutationResult,
} from "~/server/entity-kernel/contracts";

import type { EntityEditResultFor } from "./editing/intent-types";
import {
  executeEntityMutation,
  parseEntityMutationResultFor,
} from "./entity-mutation.functions";
import {
  type GeneratedBrowserCrudEntity,
  generatedBrowserCrudEntities,
} from "./generated/entity-routes.gen";

export type StandardEntity = GeneratedBrowserCrudEntity;
export type StandardAction = "create" | "update" | "delete" | "bulkUpdate";
type CommandFor<
  E extends StandardEntity,
  A extends Exclude<StandardAction, "delete">,
> = Extract<
  z.input<typeof entityBrowserMutationCommandSchema>,
  { entity: E; action: A }
>;

export type EntityMutationVariables<
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
    : A extends "bulkUpdate"
      ? CommandFor<E, "bulkUpdate"> extends { data: infer Data }
        ? { ids: string[]; data: Data }
        : never
      : { ids: string[] };

export type EntityMutationData<
  E extends StandardEntity,
  A extends StandardAction,
> = A extends "delete"
  ? { deleted: number; sideEffects: MutationSideEffects }
  : A extends "bulkUpdate"
    ? { updated: number; sideEffects: MutationSideEffects }
    : EntityEditResultFor<E> & { sideEffects: MutationSideEffects };

export type EntityMutationOptions<
  E extends StandardEntity,
  A extends StandardAction,
> = UseMutationOptions<
  EntityMutationData<E, A>,
  Error,
  EntityMutationVariables<E, A>
>;
export type EntityMutationCallbacks<
  E extends StandardEntity,
  A extends StandardAction,
> = Omit<EntityMutationOptions<E, A>, "meta" | "mutationFn" | "mutationKey">;
export type EntityMutationOptionsFactory<
  E extends StandardEntity,
  A extends StandardAction,
> = (callbacks?: EntityMutationCallbacks<E, A>) => EntityMutationOptions<E, A>;

/** The browser boundary owns the serializable command transport. */
export interface EntityMutationTransport {
  execute(
    command: EntityBrowserMutationInput,
  ): Promise<EntityBrowserMutationResult>;
}

const browserMutationTransport: EntityMutationTransport = {
  execute: (command) => executeEntityMutation({ data: command }),
};

function mutationMeta(entity: StandardEntity): CubbyOperationMeta {
  return {
    operation: "entity.mutate",
    entity,
    invalidates: entityRipple(entity),
  };
}

function mutationBase<E extends StandardEntity>(
  entity: E,
  action: StandardAction,
) {
  return {
    mutationKey: ["operation", "entity.mutate", entity, action],
    meta: mutationMeta(entity),
  };
}

function requireEntityResult<E extends StandardEntity>(
  entity: E,
  action: "create" | "update",
  result: EntityBrowserMutationResult,
): EntityEditResultFor<E> & { sideEffects: MutationSideEffects } {
  if (
    result.entity !== entity ||
    result.action !== action ||
    !("item" in result)
  )
    throw new Error("Entity mutation result did not match its command");
  return {
    ...parseEntityMutationResultFor(entity, result.item),
    sideEffects: result.sideEffects,
  };
}

function createMutationOptions<E extends StandardEntity>(
  entity: E,
  callbacks: EntityMutationCallbacks<E, "create">,
  transport: EntityMutationTransport,
): EntityMutationOptions<E, "create"> {
  return {
    ...mutationBase(entity, "create"),
    ...callbacks,
    mutationFn: async (data) =>
      requireEntityResult(
        entity,
        "create",
        await transport.execute(
          entityBrowserMutationCommandSchema.parse({
            action: "create",
            entity,
            data,
          }),
        ),
      ),
  };
}

function updateMutationOptions<E extends StandardEntity>(
  entity: E,
  callbacks: EntityMutationCallbacks<E, "update">,
  transport: EntityMutationTransport,
): EntityMutationOptions<E, "update"> {
  return {
    ...mutationBase(entity, "update"),
    ...callbacks,
    mutationFn: async ({ id, data }) =>
      requireEntityResult(
        entity,
        "update",
        await transport.execute(
          entityBrowserMutationCommandSchema.parse({
            action: "update",
            entity,
            id,
            data,
          }),
        ),
      ),
  };
}

function deleteMutationOptions<E extends StandardEntity>(
  entity: E,
  callbacks: EntityMutationCallbacks<E, "delete">,
  transport: EntityMutationTransport,
): EntityMutationOptions<E, "delete"> {
  return {
    ...mutationBase(entity, "delete"),
    ...callbacks,
    mutationFn: async ({ ids }) => {
      const result = await transport.execute(
        entityBrowserMutationCommandSchema.parse({
          action: "delete",
          entity,
          ids,
        }),
      );
      if (result.entity !== entity || result.action !== "delete")
        throw new Error("Entity mutation result did not match its command");
      return { deleted: result.deleted, sideEffects: result.sideEffects };
    },
  };
}

function bulkUpdateMutationOptions<E extends StandardEntity>(
  entity: E,
  callbacks: EntityMutationCallbacks<E, "bulkUpdate">,
  transport: EntityMutationTransport,
): EntityMutationOptions<E, "bulkUpdate"> {
  return {
    ...mutationBase(entity, "bulkUpdate"),
    ...callbacks,
    mutationFn: async ({ ids, data }) => {
      const result = await transport.execute(
        entityBrowserMutationCommandSchema.parse({
          action: "bulkUpdate",
          entity,
          ids,
          data,
        }),
      );
      if (result.entity !== entity || result.action !== "bulkUpdate")
        throw new Error("Entity mutation result did not match its command");
      return { updated: result.updated, sideEffects: result.sideEffects };
    },
  };
}

/** Typed mutation options for compiled browser CRUD entities. */
export function entityMutationOptionsFactory<E extends StandardEntity>(
  entity: E,
  action: "create",
  transport?: EntityMutationTransport,
): EntityMutationOptionsFactory<E, "create">;
export function entityMutationOptionsFactory<E extends StandardEntity>(
  entity: E,
  action: "update",
  transport?: EntityMutationTransport,
): EntityMutationOptionsFactory<E, "update">;
export function entityMutationOptionsFactory<E extends StandardEntity>(
  entity: E,
  action: "delete",
  transport?: EntityMutationTransport,
): EntityMutationOptionsFactory<E, "delete">;
export function entityMutationOptionsFactory<E extends StandardEntity>(
  entity: E,
  action: "bulkUpdate",
  transport?: EntityMutationTransport,
): EntityMutationOptionsFactory<E, "bulkUpdate">;
export function entityMutationOptionsFactory<E extends StandardEntity>(
  entity: E,
  action: StandardAction,
  transport: EntityMutationTransport = browserMutationTransport,
) {
  switch (action) {
    case "create":
      return (callbacks = {}) =>
        createMutationOptions(entity, callbacks, transport);
    case "update":
      return (callbacks = {}) =>
        updateMutationOptions(entity, callbacks, transport);
    case "delete":
      return (callbacks = {}) =>
        deleteMutationOptions(entity, callbacks, transport);
    case "bulkUpdate":
      return (callbacks = {}) =>
        bulkUpdateMutationOptions(entity, callbacks, transport);
  }
}

export const isGeneratedBrowserCrudEntity = (
  entity: string,
): entity is GeneratedBrowserCrudEntity =>
  generatedBrowserCrudEntities.some((candidate) => candidate === entity);
