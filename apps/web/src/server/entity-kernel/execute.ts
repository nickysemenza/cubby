import type { RelationMutationOut } from "@cubby/schemas/common";
import {
  ENTITY_LABEL,
  ENTITY_NOT_FOUND_REASON,
} from "@cubby/schemas/identifiers";
import {
  buildPaginatedResponse,
  normalizeSorts,
  type PaginationParams,
} from "@cubby/schemas/pagination";
import { searchableEntitySchema } from "@cubby/schemas/search";
import { z } from "zod";
import { createAppError } from "~/server/errors/app-error";
import { ENTITY_KERNEL_BINDINGS } from "~/server/generated/entity-kernel-bindings.gen";
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
import type { EntityKernelBinding, EntityKernelContext } from "./adapter";
import {
  type EntityCommand,
  type EntityKernelEntity,
  type EntityMutationCommand,
  type EntityQueryCommand,
  entityCommandSchema,
  type entityMutationResultSchema,
  type entityQueryResultSchema,
} from "./contracts";

const DEFAULT_PAGINATION: PaginationParams = { pageIndex: 0, pageSize: 10 };

function bindingFor(entity: EntityKernelEntity): EntityKernelBinding {
  return ENTITY_KERNEL_BINDINGS[entity] as unknown as EntityKernelBinding;
}

function parseSorts(
  binding: EntityKernelBinding,
  value: Extract<EntityCommand, { action: "list" }>["sort"],
) {
  const field = z.enum(binding.sort.fields);
  const raw = value ?? {
    orderBy: binding.sort.default,
    direction: "desc" as const,
  };
  const normalized = normalizeSorts(raw);
  for (const sort of normalized) field.parse(sort.orderBy);
  return normalized;
}

function parseGroupBy(
  binding: EntityKernelBinding,
  groupBy: string | undefined,
) {
  if (groupBy === undefined) return undefined;
  return z.enum(binding.sort.groupable ?? binding.sort.fields).parse(groupBy);
}

async function runSideEffects(
  ctx: EntityKernelContext,
  binding: EntityKernelBinding,
  action: "created" | "updated",
  entityId: unknown,
  source: string,
) {
  if (!binding.sideEffects) return [];
  const event = mutationSideEffectEventSchema.parse({
    action,
    entity: { entityType: binding.entity, entityId },
    source,
  });
  return await runMutationSideEffects(ctx.db, event);
}

/**
 * The one application-level entity interface.
 *
 * Repositories retain transaction ownership and entity-specific invariants.
 * This kernel owns public-id/input validation, list normalization, lifecycle
 * capability gates, and the strictly-after-commit side-effect sequence.
 */
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
      const binding = bindingFor(command.entity);
      const id = binding.schemas.id.parse(command.id);
      const item = await binding.repository.get(ctx, id);
      if (item === null) {
        if (command.missing === "null") {
          return {
            action: command.action,
            entity: command.entity,
            item: null,
          } as const;
        }
        throw createAppError(
          ENTITY_NOT_FOUND_REASON[binding.entity],
          `${ENTITY_LABEL[binding.entity]} ${command.id} not found`,
        );
      }
      return {
        action: command.action,
        entity: command.entity,
        item: binding.schemas.detail.parse(item),
      } as const;
    }

    case "list": {
      const binding = bindingFor(command.entity);
      const filters = binding.schemas.filters.parse(command.filters);
      const pagination = command.pagination ?? DEFAULT_PAGINATION;
      const { data, count, sums } = await binding.repository.list(
        ctx,
        filters,
        parseSorts(binding, command.sort),
        pagination,
        parseGroupBy(binding, command.groupBy),
      );
      const items = z.array(binding.schemas.list).parse(data);
      return {
        action: command.action,
        entity: command.entity,
        ...buildPaginatedResponse(pagination, items, count, sums),
      } as const;
    }

    case "search": {
      const entity = searchableEntitySchema.parse(command.entity);
      const input = {
        query: command.query,
        entityTypes: [entity],
        limit: command.limit,
      };
      const [lexical, semantic] = await Promise.all([
        findSearchHits(ctx.db, input),
        command.semantic
          ? findRelatedSearchHits(ctx.db, input)
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
      const binding = bindingFor(command.entity);
      const schema = binding.schemas.create;
      const create = binding.repository.create;
      if (!schema || !create) {
        throw createAppError(
          "CONSTRAINT_VIOLATION",
          `${ENTITY_LABEL[binding.entity]} does not support create`,
        );
      }
      const data = schema.parse(command.data);
      const created = await create(ctx, data);
      await deleteStoredObjects(created.detachedImageKeys ?? []);
      const backgroundBatches = [
        ...(created.backgroundBatches ?? []),
        ...(await runSideEffects(
          ctx,
          binding,
          "created",
          created.entityId,
          `${binding.entity}.create`,
        )),
      ];
      return {
        action: command.action,
        entity: command.entity,
        item: binding.schemas.output.parse(created.output),
        sideEffects: { backgroundBatches },
      } as const;
    }

    case "update": {
      const binding = bindingFor(command.entity);
      const schema = binding.schemas.update;
      const update = binding.repository.update;
      if (!schema || !update) {
        throw createAppError(
          "CONSTRAINT_VIOLATION",
          `${ENTITY_LABEL[binding.entity]} does not support update`,
        );
      }
      const id = binding.schemas.id.parse(command.id);
      const data = schema.parse(command.data);
      const updated = await update(ctx, id, data);
      await deleteStoredObjects(updated.detachedImageKeys ?? []);
      const backgroundBatches = [
        ...(updated.backgroundBatches ?? []),
        ...(await runSideEffects(
          ctx,
          binding,
          "updated",
          updated.entityId,
          `${binding.entity}.update`,
        )),
      ];
      return {
        action: command.action,
        entity: command.entity,
        item: binding.schemas.output.parse(updated.output),
        sideEffects: { backgroundBatches },
      } as const;
    }

    case "delete": {
      const binding = bindingFor(command.entity);
      // A delete-capable binding cannot exist without declaring its incoming
      // edge policy. Touch the policy at the capability gate so the contract
      // remains runtime data rather than decorative registry metadata.
      void binding.lifecycle.delete;
      const ids = command.ids.map((id) => binding.schemas.id.parse(id));
      const {
        deleted,
        detachedImageKeys = [],
        backgroundBatches = [],
        affectedEdges,
      } = await binding.repository.delete(ctx, ids);
      await deleteStoredObjects(detachedImageKeys);
      return {
        action: command.action,
        entity: command.entity,
        deleted,
        deletedReferences: command.ids.map((id) => ({
          entity: command.entity,
          id,
        })),
        affectedEdges:
          affectedEdges ??
          Object.entries(binding.lifecycle.delete).map(
            ([edge, disposition]) => ({
              edge,
              effect: disposition.effect,
              changed: null,
            }),
          ),
        sideEffects: { backgroundBatches },
      } as const;
    }

    case "merge": {
      const binding = bindingFor(command.entity);
      const merge = binding.merge;
      if (!merge || !binding.lifecycle.merge) {
        throw createAppError(
          "CONSTRAINT_VIOLATION",
          `${ENTITY_LABEL[binding.entity]} does not support merge`,
        );
      }
      const result = await merge.execute(ctx, merge.input.parse(command.data));
      await deleteStoredObjects(result.detachedImageKeys);
      const backgroundBatches = [
        ...(result.backgroundBatches ?? []),
        ...(result.entityId
          ? await runSideEffects(
              ctx,
              binding,
              "updated",
              result.entityId,
              `${binding.entity}.merge`,
            )
          : []),
      ];
      const output = merge.output.parse(result.output);
      return {
        action: command.action,
        entity: command.entity,
        item: merge.item(output),
        mergeSummary: merge.summary(output),
        sideEffects: { backgroundBatches },
      } as const;
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
