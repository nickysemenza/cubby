import type { RelationMutationOut } from "@cubby/schemas/common";
import { ENTITY_LABEL } from "@cubby/schemas/identifiers";
import { searchableEntitySchema } from "@cubby/schemas/search";
import { z } from "zod";

import { createAppError } from "~/server/errors/app-error";
import {
  ENTITY_KERNEL_BINDINGS,
  ENTITY_KERNEL_OPERATIONS,
} from "~/server/generated/entity-kernel-bindings.gen";
import {
  attachProductComponents,
  detachProductComponents,
} from "~/server/repo/product-components";
import {
  attachProjectResources,
  detachProjectResources,
} from "~/server/repo/project/tools";
import {
  attachPurchaseProducts,
  detachPurchaseProducts,
} from "~/server/repo/purchase-products";
import {
  resolveAllOrThrow,
  resolveOrThrow,
} from "~/server/repo/shortcode-resolver";
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
      return {
        action: command.action,
        entity,
        lexical,
        semantic,
      } as const;
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
    }

    case "attach":
    case "detach": {
      const ids = command.items.map((item) => item.id);
      const products = () => resolveAllOrThrow(ctx.db, "product", ids);
      let result: RelationMutationOut;
      if (command.entity === "product") {
        const parentId = await resolveOrThrow(ctx.db, "product", command.id);
        const productIds = await products();
        result =
          command.action === "attach"
            ? await attachProductComponents(
                ctx.db,
                parentId,
                productIds.map((productId, index) => ({
                  productId,
                  quantity: command.items[index]?.quantity ?? 1,
                })),
                ctx.actorContext,
              )
            : await detachProductComponents(
                ctx.db,
                parentId,
                productIds,
                ctx.actorContext,
              );
      } else if (command.entity === "project") {
        const projectId = await resolveOrThrow(ctx.db, "project", command.id);
        const productIds = await products();
        result =
          command.action === "attach"
            ? await attachProjectResources(
                ctx.db,
                projectId,
                productIds,
                ctx.actorContext,
              )
            : await detachProjectResources(
                ctx.db,
                projectId,
                productIds,
                ctx.actorContext,
              );
      } else {
        const purchaseId = await resolveOrThrow(ctx.db, "purchase", command.id);
        const productIds = await products();
        result =
          command.action === "attach"
            ? await attachPurchaseProducts(
                ctx.db,
                purchaseId,
                productIds,
                ctx.actorContext,
              )
            : await detachPurchaseProducts(
                ctx.db,
                purchaseId,
                productIds,
                ctx.actorContext,
              );
      }
      return {
        action: command.action,
        entity: command.entity,
        relation: command.relation,
        result,
      } as const;
    }
  }
}
