import { ENTITY_LABEL } from "@cubby/schemas/identifiers";
import { searchableEntitySchema } from "@cubby/schemas/search";
import { z } from "zod";

import { createAppError } from "~/server/errors/app-error";
import {
  ENTITY_KERNEL_BINDINGS,
  ENTITY_KERNEL_OPERATIONS,
} from "~/server/generated/entity-kernel-bindings.gen";
import { executeGeneratedRelationMutation } from "~/server/generated/entity-relation-bindings.gen";
import { deleteStoredObjects } from "~/server/services/image-storage.service";
import {
  mutationSideEffectEventSchema,
  runMutationSideEffects,
} from "~/server/services/mutation-side-effects";
import {
  findRelatedSearchHits,
  findSearchHits,
} from "~/server/services/search.service";

import type { EntityKernelContext } from "./adapter";
import {
  type EntityCommand,
  type EntityMutationCommand,
  type EntityQueryCommand,
  type EntityResultFor,
  entityCommandSchema,
  entityMutationResultSchema,
  type entityQueryResultSchema,
} from "./contracts";

const executeSearch = async (
  ctx: EntityKernelContext,
  command: Extract<EntityQueryCommand, { action: "search" }>,
) => {
  const entity = searchableEntitySchema.parse(command.entity);
  const input = {
    query: command.query,
    entityTypes: [entity],
    limit: command.limit,
  };
  const [lexical, semantic] = await Promise.all([
    findSearchHits(ctx.readDb, input),
    command.semantic
      ? findRelatedSearchHits(ctx.readDb, input)
      : Promise.resolve({ status: "unavailable" as const, results: [] }),
  ]);
  return { action: command.action, entity, lexical, semantic } as const;
};

const executeMerge = async (
  ctx: EntityKernelContext,
  command: Extract<EntityMutationCommand, { action: "merge" }>,
) => {
  const binding = ENTITY_KERNEL_BINDINGS[command.entity];
  const mergeOperation = binding.mergeOperation;
  if (!mergeOperation || !binding.lifecycle.merge) {
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      `${ENTITY_LABEL[binding.entity]} does not support merge`,
    );
  }
  const result = await mergeOperation.execute(ctx, command.data);
  await deleteStoredObjects(result.detachedImageKeys);
  const backgroundBatches = [
    ...(result.backgroundBatches ?? []),
    ...(result.entityId && binding.sideEffects
      ? await runMutationSideEffects(
          ctx.db,
          mutationSideEffectEventSchema.parse({
            action: "updated",
            entity: {
              entityType: binding.entity,
              entityId: result.entityId,
            },
            source: `${binding.entity}.merge`,
          }),
        )
      : []),
  ];
  return entityMutationResultSchema.parse({
    action: command.action,
    entity: command.entity,
    item: result.item,
    mergeSummary: result.mergeSummary,
    sideEffects: { backgroundBatches },
  });
};

const executeRelationMutation = async (
  ctx: EntityKernelContext,
  command: Extract<EntityMutationCommand, { action: "attach" | "detach" }>,
) => {
  return executeGeneratedRelationMutation(ctx, command);
};

/**
 * The one application-level entity interface.
 *
 * Repositories retain transaction ownership and entity-specific invariants.
 * This kernel owns public-id/input validation, list normalization, lifecycle
 * capability gates, and the strictly-after-commit side-effect sequence.
 */
export function executeEntity<Command extends EntityCommand>(
  ctx: EntityKernelContext,
  rawCommand: Command,
): Promise<EntityResultFor<Command>>;
export function executeEntity(
  ctx: EntityKernelContext,
  rawCommand: EntityQueryCommand,
): Promise<z.infer<typeof entityQueryResultSchema>>;
export function executeEntity(
  ctx: EntityKernelContext,
  rawCommand: EntityMutationCommand,
): Promise<z.infer<typeof entityMutationResultSchema>>;
export function executeEntity(
  ctx: EntityKernelContext,
  rawCommand: EntityCommand,
): Promise<
  | z.infer<typeof entityQueryResultSchema>
  | z.infer<typeof entityMutationResultSchema>
>;
export async function executeEntity(
  ctx: EntityKernelContext,
  rawCommand: EntityCommand,
): Promise<
  | z.infer<typeof entityQueryResultSchema>
  | z.infer<typeof entityMutationResultSchema>
> {
  const command = entityCommandSchema.parse(rawCommand);

  switch (command.action) {
    case "get": {
      return ENTITY_KERNEL_OPERATIONS[command.entity].get(ctx, command);
    }

    case "list": {
      return ENTITY_KERNEL_OPERATIONS[command.entity].list(ctx, command);
    }

    case "search": {
      return executeSearch(ctx, command);
    }

    case "create": {
      return ENTITY_KERNEL_OPERATIONS[command.entity].create(ctx, command.data);
    }

    case "update": {
      return ENTITY_KERNEL_OPERATIONS[command.entity].update(
        ctx,
        command.id,
        command.data,
      );
    }

    case "delete": {
      return ENTITY_KERNEL_OPERATIONS[command.entity].delete(ctx, command.ids);
    }

    case "bulkUpdate": {
      return ENTITY_KERNEL_OPERATIONS[command.entity].bulkUpdate(
        ctx,
        command.ids,
        command.data,
      );
    }

    case "merge": {
      return executeMerge(ctx, command);
    }

    case "attach":
    case "detach": {
      return executeRelationMutation(ctx, command);
    }
  }
}
