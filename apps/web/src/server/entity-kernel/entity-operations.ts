import {
  EMPTY_MUTATION_SIDE_EFFECTS,
  mutationSideEffectsWithWarnings,
} from "@cubby/schemas/background-jobs";
import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";
import {
  ENTITY_LABEL,
  ENTITY_NOT_FOUND_REASON,
  parseEntityRef,
} from "@cubby/schemas/identifiers";
import {
  buildPaginatedResponse,
  listGroupSummarySchema,
  normalizeSorts,
  type PaginationParams,
} from "@cubby/schemas/pagination";
import { z } from "zod";

import { deferPublications } from "~/server/background-tasks/publish";
import { createAppError } from "~/server/errors/app-error";
import { withTransactionDatabase } from "~/server/repo/database-helpers";
import {
  withListEntityMedia,
  withUniversalEntityMedia,
} from "~/server/repo/entity-display-image";
import {
  describeUnresolvableCode,
  isShortcodeEntity,
  resolveEntityIdentity,
} from "~/server/repo/entity-identity";
import { deleteStoredObjects } from "~/server/services/image-storage.service";
import {
  isMutationSideEffectRef,
  type MutationSideEffectEvent,
  refreshProjectionsForEvent,
  runMutationSideEffects,
} from "~/server/services/mutation-side-effects";
import { bindWorkflow, workflow } from "~/server/workflow-runtime";

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

type EntityListInput<TFilters = unknown> = {
  filters: TFilters;
  sort?:
    | { orderBy: string; direction: "asc" | "desc" }
    | { orderBy: string; direction: "asc" | "desc" }[];
  pagination?: PaginationParams;
  groupBy?: string;
};

const LIST_ID_SCAN_PAGE_SIZE = 100;

/**
 * `filters.ids` is an MCP-wide shortcode intersection, not a domain filter.
 * Keep repositories unaware of transport-only syntax while preserving their
 * own filtering and sort order. The bounded scan runs only when ids are
 * supplied and pages the repository rather than requesting an unbounded read.
 */
const listRestrictedToIds = async <
  E extends EntityKernelEntity,
  S extends EntityBindingSchemas,
>(
  binding: EntityKernelCoreBinding<E, S>,
  context: EntityKernelContext,
  filters: z.output<S["filters"]>,
  sorts: ReturnType<typeof parseSorts<E, S>>,
  groupBy: string | undefined,
  requested: PaginationParams,
  ids: readonly string[],
) => {
  const wanted = new Set(ids);
  const matching: z.output<S["repositoryList"]>[] = [];
  let pageIndex = 0;
  let totalCount = 0;
  do {
    const page = await binding.repository.list(
      context,
      filters,
      sorts,
      { pageIndex, pageSize: LIST_ID_SCAN_PAGE_SIZE },
      groupBy,
    );
    totalCount = page.count;
    matching.push(
      ...page.data.filter((item) => {
        const { id } = z.object({ id: z.string() }).parse(item);
        return wanted.has(id);
      }),
    );
    pageIndex += 1;
  } while (pageIndex * LIST_ID_SCAN_PAGE_SIZE < totalCount);

  const start = requested.pageIndex * requested.pageSize;
  return {
    data: matching.slice(start, start + requested.pageSize),
    count: matching.length,
  };
};

const DEFAULT_PAGINATION: PaginationParams = { pageIndex: 0, pageSize: 10 };

const entityListSearchSchema = z
  .object({ searchQuery: z.string().trim().min(1).max(100).optional() })
  .passthrough();

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
  allowEmpty = false,
) => {
  const field = z.enum(binding.sort.fields);
  // A list search owns its opening relevance order. Preserve a caller's
  // deliberate sort, but do not synthesize the entity's ordinary opening sort
  // when the transport omitted one — otherwise relevance is unreachable.
  if (allowEmpty && value === undefined) return [];
  const normalized = normalizeSorts(
    value ?? {
      orderBy: binding.sort.default,
      direction: binding.sort.direction,
    },
  );
  for (const sort of normalized) {
    const result = field.safeParse(sort.orderBy);
    if (!result.success)
      throw createAppError(
        "LIST_SORT_FIELD_UNSUPPORTED",
        `Unsupported sort field "${sort.orderBy}" for ${binding.entity}; expected one of ${binding.sort.fields.join(", ")}`,
      );
  }
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
  const groupable = binding.sort.groupable ?? binding.sort.fields;
  const result = z.enum(groupable).safeParse(groupBy);
  if (!result.success)
    throw createAppError(
      "LIST_GROUP_BY_FIELD_UNSUPPORTED",
      `Unsupported groupBy field "${groupBy}" for ${binding.entity}; expected one of ${groupable.join(", ")}`,
    );
  return result.data;
};

const sideEffectEventFor = <
  E extends EntityKernelEntity,
  S extends EntityBindingSchemas,
>(
  binding: EntityKernelCoreBinding<E, S>,
  action: "created" | "updated",
  entityId: EntityInternalId<E>,
  source: string,
): MutationSideEffectEvent | null => {
  // Binding lookup erases the entity/id correlation; restore it at this
  // boundary before routing to the subset that has side effects.
  const entityRef = parseEntityRef<ShortcodeEntity>(binding.entity, entityId);
  if (!binding.sideEffects || !isMutationSideEffectRef(entityRef)) return null;
  return { action, entity: entityRef, source };
};

/**
 * Run a repository write and the refresh of every search projection it
 * changes inside ONE transaction. The projection is a SQL view of the row
 * being written; a projection that cannot be written is a reason for the
 * write to fail, not something to repair later.
 */
const writeWithProjections = async <
  E extends EntityKernelEntity,
  S extends EntityBindingSchemas,
  TResult extends { entityId: EntityInternalId<E> },
>(
  context: EntityKernelContext,
  binding: EntityKernelCoreBinding<E, S>,
  action: "created" | "updated",
  source: string,
  write: (context: EntityKernelContext) => Promise<TResult>,
): Promise<TResult> => {
  if (!binding.sideEffects) return write(context);
  // Everything the adapter reaches through the context must run on the
  // transaction: a service still bound to the request pool would UPDATE a row
  // this transaction holds and wait on it forever. Its task publications are
  // held back until the commit, so no consumer can see the pre-write row.
  const deferred = deferPublications();
  const result = await withTransactionDatabase(
    context.db,
    async (transactionDb) => {
      const result = await write({
        ...context,
        db: transactionDb,
        services: {
          ...context.services,
          recipeCosting: context.services.recipeCosting.bindTo(
            transactionDb,
            deferred.publish,
          ),
        },
      });
      const event = sideEffectEventFor(
        binding,
        action,
        result.entityId,
        source,
      );
      if (event) await refreshProjectionsForEvent(transactionDb, event);
      return result;
    },
  );
  await deferred.flush(context.db);
  return result;
};

/** Post-commit effects: embedding tasks, AI refreshes, the problem-count mark. */
const runSideEffects = async <
  E extends EntityKernelEntity,
  S extends EntityBindingSchemas,
>(
  ctx: EntityKernelContext,
  binding: EntityKernelCoreBinding<E, S>,
  action: "created" | "updated",
  entityId: EntityInternalId<E>,
  source: string,
): Promise<void> => {
  const event = sideEffectEventFor(binding, action, entityId, source);
  if (!event) return;
  // The projections were refreshed inside the write transaction above.
  await runMutationSideEffects(ctx.db, event, undefined, {
    projection: "skip",
  });
};

export const defineEntityOperations = <
  const E extends EntityKernelEntity,
  const S extends EntityBindingSchemas,
>(
  binding: EntityKernelCoreBinding<E, S>,
) => ({
  get: bindWorkflow(
    workflow<EntityKernelContext, { id: string; missing: "error" | "null" }>(
      `${binding.entity}.get`,
    )
      .call("id", async (_, { input }) =>
        parseSchema<S["id"], string>(binding.schemas.id, input.id),
      )
      .call("found", async ({ context }, { input, id }) => {
        const readContext = { ...context, db: context.readDb };
        const item = await binding.repository.get(readContext, id);
        if (item !== null)
          return { item, redirectedFrom: null, missingMessage: null };
        // A merged-away code reads as its survivor (ADR 0006). Mutations never
        // follow this redirect; they refuse with the survivor's code instead.
        const identity = await resolveEntityIdentity(context.readDb, input.id);
        const canonical =
          identity.state === "redirected" &&
          identity.kind === binding.entity &&
          identity.canonicalDeletedAt === null
            ? await binding.repository.get(
                readContext,
                parseSchema<S["id"], string>(
                  binding.schemas.id,
                  identity.canonicalShortcode,
                ),
              )
            : null;
        if (canonical !== null && identity.state === "redirected")
          return {
            item: canonical,
            redirectedFrom: identity.requested,
            missingMessage: null,
          };
        return {
          item: null,
          redirectedFrom: null,
          missingMessage: isShortcodeEntity(binding.entity)
            ? await describeUnresolvableCode(
                context.readDb,
                binding.entity,
                input.id,
              )
            : null,
        };
      })
      .call("media", async ({ context }, { found }) =>
        found.item === null
          ? null
          : {
              ...(
                await withUniversalEntityMedia(
                  context.readDb,
                  binding.entity,
                  [found.item],
                  true,
                )
              )[0],
              redirectedFrom: found.redirectedFrom,
            },
      )
      .output(({ input, found, media }) => {
        if (media === null && input.missing !== "null")
          throw createAppError(
            ENTITY_NOT_FOUND_REASON[binding.entity],
            found.missingMessage ??
              `${ENTITY_LABEL[binding.entity]} ${input.id} not found`,
          );
        return entityQueryResultSchema.parse({
          action: "get",
          entity: binding.entity,
          item:
            media === null
              ? null
              : parseSchema<S["detail"], typeof media>(
                  binding.schemas.detail,
                  media,
                ),
        });
      }),
    (
      context: EntityKernelContext,
      input: { id: string; missing: "error" | "null" },
    ) => ({ context, input }),
  ),
  list: bindWorkflow(
    workflow<EntityKernelContext, EntityListInput>(`${binding.entity}.list`)
      .call("validated", async (_, { input }) => {
        const { ids, ...repositoryFilters } = z
          .object({
            ids: z.array(z.string()).max(500).optional(),
          })
          .passthrough()
          .parse(input.filters);
        for (const id of ids ?? []) binding.schemas.id.parse(id);
        const filters = parseSchema<S["filters"], unknown>(
          binding.schemas.filters,
          repositoryFilters,
        );
        const searchQuery = entityListSearchSchema.parse(filters).searchQuery;
        return {
          filters,
          ids,
          pagination: input.pagination ?? DEFAULT_PAGINATION,
          sorts: parseSorts(binding, input.sort, Boolean(searchQuery)),
          groupBy: parseGroupBy(binding, input.groupBy),
        };
      })
      .call("page", async ({ context }, { validated }) => {
        const readContext =
          context.readDb === context.db
            ? context
            : { ...context, db: context.readDb };
        return validated.ids
          ? listRestrictedToIds(
              binding,
              readContext,
              validated.filters,
              validated.sorts,
              validated.groupBy,
              validated.pagination,
              validated.ids,
            )
          : binding.repository.list(
              readContext,
              validated.filters,
              validated.sorts,
              validated.pagination,
              validated.groupBy,
            );
      })
      .call("mediaPage", async ({ context }, { page }) => ({
        ...page,
        data: await withListEntityMedia(
          context.readDb,
          binding.entity,
          page.data,
        ),
      }))
      .output(({ validated, mediaPage }) =>
        entityQueryResultSchema.parse({
          action: "list",
          entity: binding.entity,
          ...buildPaginatedResponse(
            validated.pagination,
            z.array(binding.schemas.list).parse(mediaPage.data),
            mediaPage.count,
            "sums" in mediaPage
              ? z
                  .record(z.string(), z.number())
                  .optional()
                  .parse(mediaPage.sums)
              : undefined,
            "groups" in mediaPage
              ? z
                  .array(listGroupSummarySchema)
                  .optional()
                  .parse(mediaPage.groups)
              : undefined,
          ),
        }),
      ),
    <TFilters>(
      context: EntityKernelContext,
      input: EntityListInput<TFilters>,
    ) => ({ context, input }),
  ),
  create: bindWorkflow(
    workflow<EntityKernelContext, unknown>(`${binding.entity}.create`)
      .call("validated", async (_, { input }) => {
        const schema = binding.schemas.createInput;
        const run = binding.repository.create;
        if (!schema || !run)
          throw createAppError(
            "CONSTRAINT_VIOLATION",
            `${ENTITY_LABEL[binding.entity]} does not support create`,
          );
        return {
          run,
          data: parseSchema(presentSchema<S["createInput"]>(schema), input),
        };
      })
      .commit("created", async ({ context }, { validated }) =>
        writeWithProjections(
          context,
          binding,
          "created",
          `${binding.entity}.create`,
          (writeContext) => validated.run(writeContext, validated.data),
        ),
      )
      .effect("storage", async (_, { created }) =>
        deleteStoredObjects(created.detachedImageKeys ?? []),
      )
      .effect("sideEffects", async ({ context }, { created }) =>
        runSideEffects(
          context,
          binding,
          "created",
          created.entityId,
          `${binding.entity}.create`,
        ),
      )
      .output(({ created }) =>
        entityMutationResultSchema.parse({
          action: "create",
          entity: binding.entity,
          item: parseSchema<S["output"], typeof created.output>(
            binding.schemas.output,
            created.output,
          ),
          sideEffects: mutationSideEffectsWithWarnings(created.warnings),
        }),
      ),
    <TInput>(context: EntityKernelContext, input: TInput) => ({
      context,
      input,
    }),
  ),
  update: bindWorkflow(
    workflow<EntityKernelContext, { id: string; data: unknown }>(
      `${binding.entity}.update`,
    )
      .call("validated", async (_, { input }) => {
        const schema = binding.schemas.updateInput;
        const run = binding.repository.update;
        if (!schema || !run)
          throw createAppError(
            "CONSTRAINT_VIOLATION",
            `${ENTITY_LABEL[binding.entity]} does not support update`,
          );
        return {
          run,
          id: parseSchema<S["id"], string>(binding.schemas.id, input.id),
          data: parseSchema(
            presentSchema<S["updateInput"]>(schema),
            input.data,
          ),
        };
      })
      .commit("updated", async ({ context }, { validated }) =>
        writeWithProjections(
          context,
          binding,
          "updated",
          `${binding.entity}.update`,
          (writeContext) =>
            validated.run(writeContext, validated.id, validated.data),
        ),
      )
      .effect("storage", async (_, { updated }) =>
        deleteStoredObjects(updated.detachedImageKeys ?? []),
      )
      .effect("sideEffects", async ({ context }, { updated }) =>
        runSideEffects(
          context,
          binding,
          "updated",
          updated.entityId,
          `${binding.entity}.update`,
        ),
      )
      .output(({ updated }) =>
        entityMutationResultSchema.parse({
          action: "update",
          entity: binding.entity,
          item: parseSchema<S["output"], typeof updated.output>(
            binding.schemas.output,
            updated.output,
          ),
          sideEffects: mutationSideEffectsWithWarnings(updated.warnings),
        }),
      ),
    <TInput>(context: EntityKernelContext, id: string, data: TInput) => ({
      context,
      input: { id, data },
    }),
  ),
  delete: bindWorkflow(
    workflow<EntityKernelContext, string[]>(`${binding.entity}.delete`)
      .call("ids", async (_, { input }) =>
        input.map((id) => parseSchema<S["id"], string>(binding.schemas.id, id)),
      )
      .commit("deleted", async ({ context }, { ids }) =>
        binding.repository.delete(context, ids),
      )
      .effect("receipt", async (_, { deleted }) => {
        if (!deleted.affectedEdges)
          throw new Error(
            `${binding.entity} delete returned without affected-edge counts`,
          );
        return { ...deleted, affectedEdges: deleted.affectedEdges };
      })
      .effect("storage", async (_, { receipt }) =>
        deleteStoredObjects(receipt.detachedImageKeys ?? []),
      )
      .output(({ receipt }) =>
        entityMutationResultSchema.parse({
          action: "delete",
          entity: binding.entity,
          deletedReferences: receipt.deletedReferences,
          affectedEdges: receipt.affectedEdges,
          sideEffects: EMPTY_MUTATION_SIDE_EFFECTS,
        }),
      ),
    (context: EntityKernelContext, input: string[]) => ({ context, input }),
  ),
  bulkUpdate: bindWorkflow(
    workflow<EntityKernelContext, { ids: string[]; data: unknown }>(
      `${binding.entity}.bulkUpdate`,
    )
      .call("validated", async (_, { input }) => {
        const schema = binding.schemas.bulkUpdateInput;
        const run = binding.repository.bulkUpdate;
        if (!schema || !run)
          throw createAppError(
            "CONSTRAINT_VIOLATION",
            `${ENTITY_LABEL[binding.entity]} does not support bulk update`,
          );
        return {
          run,
          ids: input.ids.map((id) =>
            parseSchema<S["id"], string>(binding.schemas.id, id),
          ),
          data: parseSchema(
            presentSchema<S["bulkUpdateInput"]>(schema),
            input.data,
          ),
        };
      })
      .commit("updated", async ({ context }, { validated }) =>
        validated.run(context, validated.ids, validated.data),
      )
      .effect("storage", async (_, { updated }) =>
        deleteStoredObjects(updated.detachedImageKeys ?? []),
      )
      .output(({ updated }) =>
        entityMutationResultSchema.parse({
          action: "bulkUpdate",
          entity: binding.entity,
          updatedReferences: updated.updatedReferences,
          sideEffects: EMPTY_MUTATION_SIDE_EFFECTS,
        }),
      ),
    <TInput>(context: EntityKernelContext, ids: string[], data: TInput) => ({
      context,
      input: { ids, data },
    }),
  ),
});
