import { EMPTY_MUTATION_SIDE_EFFECTS } from "@cubby/schemas/background-jobs";
import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";
import { ENTITY_LABEL, parseEntityRef } from "@cubby/schemas/identifiers";
import { searchableEntitySchema } from "@cubby/schemas/search";
import { z } from "zod";

import { generatedEntityRelationListResultSchema } from "~/entities/generated/entity-relation-lists.gen";
import { createAppError } from "~/server/errors/app-error";
import {
  ENTITY_KERNEL_BINDINGS,
  ENTITY_KERNEL_OPERATIONS,
} from "~/server/generated/entity-kernel-bindings.gen";
import {
  executeGeneratedRelationMutation,
  listGeneratedRelation,
} from "~/server/generated/entity-relation-bindings.gen";
import { deleteStoredObjects } from "~/server/services/image-storage.service";
import {
  isMutationSideEffectRef,
  runMutationSideEffects,
} from "~/server/services/mutation-side-effects";
import {
  findRelatedSearchHits,
  findSearchHits,
} from "~/server/services/search.service";
import { bindWorkflow, workflow } from "~/server/workflow-runtime";

import type { EntityKernelContext } from "./adapter";
import {
  type EntityCommand,
  type EntityMutationCommand,
  type EntityQueryCommand,
  type EntityResultFor,
  entityCommandSchema,
  entityBrowserMutationResultSchema,
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

type MergeCommand = Extract<EntityMutationCommand, { action: "merge" }>;
const executeMerge = bindWorkflow(
  workflow<EntityKernelContext, MergeCommand>("entity.merge")
    .call("owner", async (_, { input }) => {
      const binding = ENTITY_KERNEL_BINDINGS[input.entity];
      const operation = binding.mergeOperation;
      if (!operation || !binding.lifecycle.merge) {
        throw createAppError(
          "CONSTRAINT_VIOLATION",
          `${ENTITY_LABEL[binding.entity]} does not support merge`,
        );
      }
      return { binding, operation };
    })
    .commit("merged", async ({ context }, { input, owner }) =>
      owner.operation.execute(context, input.data),
    )
    .effect("storage", async (_, { merged }) =>
      deleteStoredObjects(merged.detachedImageKeys),
    )
    .effect("sideEffects", async ({ context }, { owner, merged }) => {
      const entityRef = merged.entityId
        ? parseEntityRef<ShortcodeEntity>(owner.binding.entity, merged.entityId)
        : null;
      if (
        entityRef &&
        owner.binding.sideEffects &&
        isMutationSideEffectRef(entityRef)
      ) {
        await runMutationSideEffects(context.db, {
          action: "updated",
          entity: entityRef,
          source: `${owner.binding.entity}.merge`,
        });
      }
    })
    .output(({ input, merged }) =>
      entityBrowserMutationResultSchema.parse({
        action: input.action,
        entity: input.entity,
        item: merged.item,
        mergeSummary: merged.mergeSummary,
        sideEffects: EMPTY_MUTATION_SIDE_EFFECTS,
      }),
    ),
  (context: EntityKernelContext, input: MergeCommand) => ({ context, input }),
);

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
): Promise<z.infer<typeof entityBrowserMutationResultSchema>>;
export function executeEntity(
  ctx: EntityKernelContext,
  rawCommand: EntityCommand,
): Promise<
  | z.infer<typeof entityQueryResultSchema>
  | z.infer<typeof entityBrowserMutationResultSchema>
>;
export async function executeEntity(
  ctx: EntityKernelContext,
  rawCommand: EntityCommand,
): Promise<
  | z.infer<typeof entityQueryResultSchema>
  | z.infer<typeof entityBrowserMutationResultSchema>
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

    case "listRelation": {
      return generatedEntityRelationListResultSchema.parse(
        await listGeneratedRelation(ctx, command),
      );
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
