import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";
import {
  ENTITY_LABEL,
  ENTITY_NOT_FOUND_REASON,
  parseEntityRef,
} from "@cubby/schemas/identifiers";
import {
  buildPaginatedResponse,
  normalizeSorts,
  type PaginationParams,
} from "@cubby/schemas/pagination";
import { z } from "zod";

import { createAppError } from "~/server/errors/app-error";
import { deleteStoredObjects } from "~/server/services/image-storage.service";
import {
  isMutationSideEffectRef,
  runMutationSideEffects,
} from "~/server/services/mutation-side-effects";

import type {
  EntityBindingSchemas,
  EntityInternalId,
  EntityKernelContext,
  EntityKernelCoreBinding,
} from "./adapter";
import {
  type EntityKernelEntity,
  entityMutationResultSchema,
  entityQueryResultSchema,
} from "./contracts";

const DEFAULT_PAGINATION: PaginationParams = { pageIndex: 0, pageSize: 10 };

const parseSchema = <S extends z.ZodType, TInput>(
  schema: S,
  input: TInput,
): z.output<S> => schema.parse(input);

const presentSchema = <S extends z.ZodType | null>(
  schema: S,
): Extract<S, z.ZodType> =>
  z
    .custom<Extract<S, z.ZodType>>(
      (candidate) => candidate !== null && candidate !== undefined,
      "Expected an entity capability schema",
    )
    .parse(schema);

const parseSorts = <
  E extends EntityKernelEntity,
  S extends EntityBindingSchemas,
>(
  binding: EntityKernelCoreBinding<E, S>,
  value:
    | { orderBy: string; direction: "asc" | "desc" }
    | { orderBy: string; direction: "asc" | "desc" }[]
    | undefined,
) => {
  const field = z.enum(binding.sort.fields);
  const normalized = normalizeSorts(
    value ?? { orderBy: binding.sort.default, direction: "desc" },
  );
  for (const sort of normalized) field.parse(sort.orderBy);
  return normalized;
};

const parseGroupBy = <
  E extends EntityKernelEntity,
  S extends EntityBindingSchemas,
>(
  binding: EntityKernelCoreBinding<E, S>,
  groupBy: string | undefined,
) => {
  if (groupBy === undefined) return undefined;
  return z.enum(binding.sort.groupable ?? binding.sort.fields).parse(groupBy);
};

const runSideEffects = async <
  E extends EntityKernelEntity,
  S extends EntityBindingSchemas,
>(
  ctx: EntityKernelContext,
  binding: EntityKernelCoreBinding<E, S>,
  action: "created" | "updated",
  entityId: EntityInternalId<E>,
  source: string,
) => {
  // Binding lookup erases the entity/id correlation; restore it at this
  // boundary before routing to the subset that has side effects.
  const entityRef = parseEntityRef<ShortcodeEntity>(binding.entity, entityId);
  if (!binding.sideEffects || !isMutationSideEffectRef(entityRef)) return [];
  return await runMutationSideEffects(ctx.db, {
    action,
    entity: entityRef,
    source,
  });
};

export const defineEntityOperations = <
  const E extends EntityKernelEntity,
  const S extends EntityBindingSchemas,
>(
  binding: EntityKernelCoreBinding<E, S>,
) => ({
  get: async (
    ctx: EntityKernelContext,
    command: { id: string; missing: "error" | "null" },
  ) => {
    const id = parseSchema<S["id"], string>(binding.schemas.id, command.id);
    const readContext =
      ctx.actorContext.source === "ui" && ctx.readDb !== ctx.db
        ? { ...ctx, db: ctx.readDb }
        : ctx;
    const item = await binding.repository.get(readContext, id);
    if (item === null && command.missing !== "null") {
      throw createAppError(
        ENTITY_NOT_FOUND_REASON[binding.entity],
        `${ENTITY_LABEL[binding.entity]} ${command.id} not found`,
      );
    }
    return entityQueryResultSchema.parse({
      action: "get",
      entity: binding.entity,
      item:
        item === null
          ? null
          : parseSchema<S["detail"], typeof item>(binding.schemas.detail, item),
    });
  },
  list: async <TFilters>(
    ctx: EntityKernelContext,
    command: {
      filters: TFilters;
      sort?:
        | { orderBy: string; direction: "asc" | "desc" }
        | { orderBy: string; direction: "asc" | "desc" }[];
      pagination?: PaginationParams;
      groupBy?: string;
    },
  ) => {
    const readContext =
      ctx.readDb === ctx.db ? ctx : { ...ctx, db: ctx.readDb };
    const filters = parseSchema<S["filters"], TFilters>(
      binding.schemas.filters,
      command.filters,
    );
    const pagination = command.pagination ?? DEFAULT_PAGINATION;
    const { data, count, sums } = await binding.repository.list(
      readContext,
      filters,
      parseSorts(binding, command.sort),
      pagination,
      parseGroupBy(binding, command.groupBy),
    );
    const items = z.array(binding.schemas.list).parse(data);
    return entityQueryResultSchema.parse({
      action: "list",
      entity: binding.entity,
      ...buildPaginatedResponse(pagination, items, count, sums),
    });
  },
  create: async <TInput>(ctx: EntityKernelContext, input: TInput) => {
    const schema = binding.schemas.createInput;
    const create = binding.repository.create;
    if (!schema || !create) {
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        `${ENTITY_LABEL[binding.entity]} does not support create`,
      );
    }
    const created = await create(
      ctx,
      parseSchema(presentSchema<S["createInput"]>(schema), input),
    );
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
    return entityMutationResultSchema.parse({
      action: "create",
      entity: binding.entity,
      item: parseSchema<S["output"], typeof created.output>(
        binding.schemas.output,
        created.output,
      ),
      sideEffects: { backgroundBatches },
    });
  },
  update: async <TInput>(
    ctx: EntityKernelContext,
    idInput: string,
    input: TInput,
  ) => {
    const schema = binding.schemas.updateInput;
    const update = binding.repository.update;
    if (!schema || !update) {
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        `${ENTITY_LABEL[binding.entity]} does not support update`,
      );
    }
    const id = parseSchema<S["id"], string>(binding.schemas.id, idInput);
    const updated = await update(
      ctx,
      id,
      parseSchema(presentSchema<S["updateInput"]>(schema), input),
    );
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
    return entityMutationResultSchema.parse({
      action: "update",
      entity: binding.entity,
      item: parseSchema<S["output"], typeof updated.output>(
        binding.schemas.output,
        updated.output,
      ),
      sideEffects: { backgroundBatches },
    });
  },
  delete: async (ctx: EntityKernelContext, idInputs: string[]) => {
    const ids = idInputs.map((id) =>
      parseSchema<S["id"], string>(binding.schemas.id, id),
    );
    const {
      deletedReferences,
      detachedImageKeys = [],
      backgroundBatches = [],
      affectedEdges,
    } = await binding.repository.delete(ctx, ids);
    if (!affectedEdges) {
      throw new Error(
        `${binding.entity} delete returned without affected-edge counts`,
      );
    }
    await deleteStoredObjects(detachedImageKeys);
    return entityMutationResultSchema.parse({
      action: "delete",
      entity: binding.entity,
      deletedReferences,
      affectedEdges,
      sideEffects: { backgroundBatches },
    });
  },
  bulkUpdate: async <TInput>(
    ctx: EntityKernelContext,
    idInputs: string[],
    input: TInput,
  ) => {
    const schema = binding.schemas.bulkUpdateInput;
    const bulkUpdate = binding.repository.bulkUpdate;
    if (!schema || !bulkUpdate) {
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        `${ENTITY_LABEL[binding.entity]} does not support bulk update`,
      );
    }
    const ids = idInputs.map((id) =>
      parseSchema<S["id"], string>(binding.schemas.id, id),
    );
    const {
      updatedReferences,
      detachedImageKeys = [],
      backgroundBatches = [],
    } = await bulkUpdate(
      ctx,
      ids,
      parseSchema(presentSchema<S["bulkUpdateInput"]>(schema), input),
    );
    await deleteStoredObjects(detachedImageKeys);
    return entityMutationResultSchema.parse({
      action: "bulkUpdate",
      entity: binding.entity,
      updatedReferences,
      sideEffects: { backgroundBatches },
    });
  },
});
