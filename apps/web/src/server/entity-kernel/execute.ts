import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";
import { ENTITY_LABEL, parseEntityRef } from "@cubby/schemas/identifiers";
import { EMPTY_MUTATION_SIDE_EFFECTS } from "@cubby/schemas/mutation-side-effects";
import { searchableEntitySchema } from "@cubby/schemas/search";
import { z } from "zod";

import { generatedEntityRelationListResultSchema } from "~/entity/generated/entity-relation-lists.gen";
import { createAppError } from "~/server/errors/app-error";
import {
  ENTITY_KERNEL_BINDINGS,
  ENTITY_KERNEL_OPERATIONS,
} from "~/server/generated/entity-kernel-bindings.gen";
import { generatedEntityResolveCapabilities } from "~/server/generated/entity-kernel-entities.gen";
import {
  executeGeneratedRelationMutation,
  listGeneratedRelation,
} from "~/server/generated/entity-relation-bindings.gen";
import { withTransactionDatabase } from "~/server/repo/database-helpers";
import { runAfterCommit } from "~/server/repo/database-helpers/core";
import { deleteStoredObjects } from "~/server/services/image-storage.service";
import {
  isMutationSideEffectRef,
  type MutationSideEffectEvent,
  refreshProjectionsForEvent,
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
  type EntityResultForAction,
  entityCommandSchema,
  entityBrowserMutationResultSchema,
  type EntityResolveCommand,
  entityResolveCommandSchema,
  entityResolveResultSchema,
  type entityQueryResultSchema,
} from "./contracts";
import { resolveNames } from "./resolve";

const executeSearch = async (
  ctx: EntityKernelContext,
  command: Extract<EntityQueryCommand, { action: "search" }>,
) => {
  const entity = searchableEntitySchema.parse(command.entity);
  const input = {
    query: command.query,
    entityKinds: [entity],
    limit: command.limit,
  };
  const [lexical, semantic] = await Promise.all([
    findSearchHits(ctx.db, input),
    command.semantic
      ? findRelatedSearchHits(ctx.db, input)
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
    // Inside a caller's transaction the R2 delete waits for its commit.
    .effect("storage", async ({ context }, { merged }) =>
      runAfterCommit(context.db, () =>
        deleteStoredObjects(merged.detachedImageKeys),
      ),
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
);

/**
 * The kernel `resolve` action over the declared `capabilities.resolve`. A
 * creating resolve runs in one kernel-owned transaction with the created
 * rows' projections; their post-commit effects follow the commit.
 */
export const resolveEntity = async (
  ctx: EntityKernelContext,
  rawCommand: EntityResolveCommand,
): Promise<z.infer<typeof entityResolveResultSchema>> => {
  const command = entityResolveCommandSchema.parse(rawCommand);
  const { entity } = command;
  const requests = command.names.map((name) => ({ name }));
  if (
    command.create &&
    !generatedEntityResolveCapabilities[entity].createMissing
  )
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      `${ENTITY_LABEL[entity]} resolve never creates rows; create the missing ${ENTITY_LABEL[entity]} explicitly or pick a candidate.`,
    );
  const source = `${entity}.resolve`;
  const createdEvents = (
    resolved: Awaited<ReturnType<typeof resolveNames>>,
  ): MutationSideEffectEvent[] =>
    ENTITY_KERNEL_BINDINGS[entity].sideEffects
      ? [
          ...new Set(
            resolved.flatMap(({ row }) => (row?.created ? [row.id] : [])),
          ),
        ].flatMap((id) => {
          const ref = parseEntityRef<ShortcodeEntity>(entity, id);
          return isMutationSideEffectRef(ref)
            ? [{ action: "created" as const, entity: ref, source }]
            : [];
        })
      : [];
  const resolved = command.create
    ? await withTransactionDatabase(ctx.db, async (transactionDb) => {
        const rows = await resolveNames(transactionDb, entity, requests, {
          create: true,
          actor: ctx.actorContext,
        });
        for (const event of createdEvents(rows))
          await refreshProjectionsForEvent(transactionDb, event);
        return rows;
      })
    : await resolveNames(ctx.db, entity, requests, { create: false });
  for (const event of createdEvents(resolved))
    await runMutationSideEffects(ctx.db, event, undefined, {
      projection: "skip",
    });
  return entityResolveResultSchema.parse({
    action: "resolve",
    entity,
    items: resolved.map(({ name, row, candidates }) => ({
      name,
      id: row?.shortcode ?? null,
      matched: row !== null && !row.created,
      created: row?.created ?? false,
      matchValues: row?.matchValues ?? [],
      candidates: candidates.map((candidate) => ({
        id: candidate.shortcode,
        name: candidate.name,
      })),
    })),
    sideEffects: EMPTY_MUTATION_SIDE_EFFECTS,
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
      return ENTITY_KERNEL_OPERATIONS[command.entity].create(ctx, {
        data: command.data,
        sources: command.sources,
      });
    }

    case "update": {
      return ENTITY_KERNEL_OPERATIONS[command.entity].update(ctx, {
        id: command.id,
        data: command.data,
        sources: command.sources,
      });
    }

    case "delete": {
      return ENTITY_KERNEL_OPERATIONS[command.entity].delete(ctx, command.ids);
    }

    case "bulkUpdate": {
      return ENTITY_KERNEL_OPERATIONS[command.entity].bulkUpdate(ctx, {
        ids: command.ids,
        data: command.data,
      });
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

type CommandOf<Action extends EntityCommand["action"]> = Extract<
  EntityCommand,
  { action: Action }
>;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

/**
 * {@link executeEntity} for a caller that issues one known action and needs
 * that action's result: the kernel's answer is checked against `action` once
 * here, so a workflow does not repeat a "returned the wrong action" guard just
 * to narrow the union.
 */
export async function executeEntityAs<
  const Action extends EntityCommand["action"],
  const Command extends DistributiveOmit<CommandOf<Action>, "action">,
>(
  ctx: EntityKernelContext,
  action: Action,
  command: Command,
): Promise<EntityResultForAction<Action, Command["entity"]>> {
  // SAFETY: `Command` is the action-less shape of an `Action` command, so
  // restoring `action` rebuilds a member of the command union.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- the generic spread cannot be proven to be a union member; executeEntity re-parses it.
  const result = await executeEntity(ctx, {
    ...command,
    action,
  } as unknown as EntityCommand);
  if (result.action !== action) {
    throw new Error(
      `Entity kernel answered a ${action} command with a ${result.action} result`,
    );
  }
  // SAFETY: the guard proves the result's action is `Action`; the kernel
  // returns the command's own entity.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- the guard above narrows by value, not by the generic Action.
  return result as unknown as EntityResultForAction<Action, Command["entity"]>;
}
