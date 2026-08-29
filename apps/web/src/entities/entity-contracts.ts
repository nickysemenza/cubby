import type { MutationSideEffects } from "@cubby/schemas/background-jobs";
import type { UseMutationOptions } from "@tanstack/react-query";
import { z } from "zod";

import { entityRipple } from "~/integrations/tanstack-query/cache-tags";
import type { CubbyOperationMeta } from "~/integrations/tanstack-query/operation-meta";
import { entityBrowserMutationCommandSchema } from "~/server/entity-kernel/contracts";

import type { EntityEditResultFor } from "./editing/intent-types";
import {
  executeEntityMutationCommand,
  type EntityMutationTransport,
} from "./entity-mutation-command";
import {
  countPrimaryDeletedReferences,
  parseEntityWriteResult,
} from "./entity-mutation.functions";
import {
  type GeneratedBrowserCrudEntity,
  generatedBrowserCrudEntities,
} from "./generated/entity-routes.gen";
export type { EntityMutationTransport } from "./entity-mutation-command";

const unparsedEntityMutationVariablesSchema = z.unknown();
type UnparsedEntityMutationVariables = z.input<
  typeof unparsedEntityMutationVariablesSchema
>;

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

type EntityMutationOptions<
  E extends StandardEntity,
  A extends StandardAction,
> = UseMutationOptions<
  EntityMutationData<E, A>,
  Error,
  EntityMutationVariables<E, A>
>;
type EntityMutationCallbacks<
  E extends StandardEntity,
  A extends StandardAction,
> = Omit<EntityMutationOptions<E, A>, "meta" | "mutationFn" | "mutationKey">;
export type EntityMutationOptionsFactory<
  E extends StandardEntity,
  A extends StandardAction,
> = (callbacks?: EntityMutationCallbacks<E, A>) => EntityMutationOptions<E, A>;

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
  transport?: EntityMutationTransport,
) {
  return (callbacks = {}) => ({
    ...mutationBase(entity, action),
    ...callbacks,
    mutationFn: async (variables: UnparsedEntityMutationVariables) => {
      if (action === "create") {
        return parseEntityWriteResult(
          entity,
          action,
          await executeEntityMutationCommand(
            entity,
            { action, entity, data: variables },
            transport,
          ),
        );
      }
      const values = z.record(z.string(), z.unknown()).parse(variables);
      const result = await executeEntityMutationCommand(
        entity,
        action === "update"
          ? { action, entity, id: values.id, data: values.data }
          : action === "bulkUpdate"
            ? { action, entity, ids: values.ids, data: values.data }
            : { action, entity, ids: values.ids },
        transport,
      );
      if (action === "update") {
        return parseEntityWriteResult(entity, action, result);
      }
      if (result.action === "delete") {
        return {
          deleted: countPrimaryDeletedReferences(result),
          sideEffects: result.sideEffects,
        };
      }
      if (result.action === "bulkUpdate") {
        return {
          updated: result.updatedReferences.length,
          sideEffects: result.sideEffects,
        };
      }
      throw new Error("Entity mutation result did not match its command");
    },
  });
}

export const isGeneratedBrowserCrudEntity = (
  entity: string,
): entity is GeneratedBrowserCrudEntity =>
  generatedBrowserCrudEntities.some((candidate) => candidate === entity);
