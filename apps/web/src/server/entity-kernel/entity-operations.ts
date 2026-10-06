import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";
import {
  ENTITY_LABEL,
  ENTITY_NOT_FOUND_REASON,
  parseEntityRef,
} from "@cubby/schemas/identifiers";
import {
  EMPTY_MUTATION_SIDE_EFFECTS,
  mutationSideEffectsWithWarnings,
} from "@cubby/schemas/mutation-side-effects";
import {
  buildPaginatedResponse,
  DEFAULT_PAGE_SIZE,
  listGroupSummarySchema,
  type PaginationParams,
} from "@cubby/schemas/pagination";
import { z } from "zod";

import { deferPublications } from "~/server/background-tasks/publish";
import { createAppError } from "~/server/errors/app-error";
import { withTransactionDatabase } from "~/server/repo/database-helpers";
import { runAfterCommit } from "~/server/repo/database-helpers/core";
import {
  withListEntityMedia,
  withUniversalEntityMedia,
} from "~/server/repo/entity-display-image";
import {
  normalizeRecordEmoji,
  repositoryRecordInput,
  writeRecordEmoji,
  withRecordEmoji,
  recordEmojiBeforeUpdate,
  auditRecordEmoji,
  normalizeSavedRecordEmoji,
} from "~/server/repo/entity-emoji";
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
  entityBrowserMutationResultSchema,
  entityQueryResultSchema,
} from "./contracts";
import { parseSchema, parseSorts, parseGroupBy } from "./list-input";

type EntityListInput<TFilters = unknown> = {
  filters: TFilters;
  sort?: { orderBy: string; direction: "asc" | "desc" }[];
  pagination?: PaginationParams;
  groupBy?: string;
};

const DEFAULT_PAGINATION: PaginationParams = {
  pageIndex: 0,
  pageSize: DEFAULT_PAGE_SIZE,
};

const entityListSearchSchema = z
  .object({ searchQuery: z.string().trim().min(1).max(100).optional() })
  .passthrough();

const presentSchema = <S extends z.ZodType | null>(
  schema: S,
): Extract<S, z.ZodType> =>
  z
    .custom<Extract<S, z.ZodType>>(
      (candidate) => candidate !== null && candidate !== undefined,
      "Expected an entity capability schema",
    )
    .parse(schema);

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
  // Every declared write, including identity-only entities, uses the transaction-bound context.
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

/**
 * An R2 delete has no rollback. When this kernel unit runs inside a caller's
 * transaction (the MCP purchase-agent call), its commit is only a savepoint
 * release, so the delete waits for the outermost commit.
 */
const deleteDetachedObjects = (
  context: EntityKernelContext,
  keys: string[] | undefined,
) => runAfterCommit(context.db, () => deleteStoredObjects(keys ?? []));

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
        const item = await binding.repository.get(context, id);
        if (item !== null)
          return { item, redirectedFrom: null, missingMessage: null };
        // A merged-away code reads as its survivor (ADR 0006). Mutations never
        // follow this redirect; they refuse with the survivor's code instead.
        const identity = await resolveEntityIdentity(context.db, input.id);
        const canonical =
          identity.state === "redirected" &&
          identity.kind === binding.entity &&
          identity.canonicalDeletedAt === null
            ? await binding.repository.get(
                context,
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
                context.db,
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
                  context.db,
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
        return binding.repository.list(
          context,
          Object.assign(
            {},
            validated.filters,
            validated.ids === undefined ? {} : { ids: validated.ids },
          ),
          validated.sorts,
          validated.pagination,
          validated.groupBy,
        );
      })
      .call("mediaPage", async ({ context }, { page }) => ({
        ...page,
        data: await withListEntityMedia(context.db, binding.entity, page.data),
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
          data: parseSchema(
            presentSchema<S["createInput"]>(schema),
            normalizeRecordEmoji(binding.entity, input),
          ),
        };
      })
      .commit("created", async ({ context }, { validated }) =>
        writeWithProjections(
          context,
          binding,
          "created",
          `${binding.entity}.create`,
          async (writeContext) => {
            const created = await validated.run(
              writeContext,
              parseSchema(
                presentSchema<S["createInput"]>(binding.schemas.createInput),
                repositoryRecordInput(binding.entity, validated.data),
              ),
            );
            await writeRecordEmoji(
              writeContext.db,
              binding.entity,
              created.entityId,
              validated.data,
            );
            return {
              ...created,
              output: (
                await withRecordEmoji(writeContext.db, binding.entity, [
                  created.output,
                ])
              )[0],
            };
          },
        ),
      )
      .effect("storage", async ({ context }, { created }) =>
        deleteDetachedObjects(context, created.detachedImageKeys),
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
        entityBrowserMutationResultSchema.parse({
          action: "create",
          entity: binding.entity,
          item: parseSchema<S["output"], typeof created.output>(
            binding.schemas.output,
            created.output,
          ),
          sideEffects: mutationSideEffectsWithWarnings(created.warnings),
        }),
      ),
  ),
  update: bindWorkflow(
    workflow<EntityKernelContext, { id: string; data: unknown }>(
      `${binding.entity}.update`,
    )
      .call("validated", async ({ context }, { input }) => {
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
            await normalizeSavedRecordEmoji(
              context.db,
              binding.entity,
              input.id,
              input.data,
            ),
          ),
        };
      })
      .commit("updated", async ({ context }, { validated }) =>
        writeWithProjections(
          context,
          binding,
          "updated",
          `${binding.entity}.update`,
          async (writeContext) => {
            const previousEmoji = await recordEmojiBeforeUpdate(
              writeContext.db,
              binding.entity,
              z.string().parse(validated.id),
              validated.data,
            );
            const updated = await validated.run(
              writeContext,
              validated.id,
              parseSchema(
                presentSchema<S["updateInput"]>(binding.schemas.updateInput),
                repositoryRecordInput(binding.entity, validated.data),
              ),
            );
            await writeRecordEmoji(
              writeContext.db,
              binding.entity,
              updated.entityId,
              validated.data,
            );
            await auditRecordEmoji(
              writeContext.db,
              writeContext.actorContext,
              binding.entity,
              updated.entityId,
              previousEmoji,
              validated.data,
            );
            return {
              ...updated,
              output: (
                await withRecordEmoji(writeContext.db, binding.entity, [
                  updated.output,
                ])
              )[0],
            };
          },
        ),
      )
      .effect("storage", async ({ context }, { updated }) =>
        deleteDetachedObjects(context, updated.detachedImageKeys),
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
        entityBrowserMutationResultSchema.parse({
          action: "update",
          entity: binding.entity,
          item: parseSchema<S["output"], typeof updated.output>(
            binding.schemas.output,
            updated.output,
          ),
          sideEffects: mutationSideEffectsWithWarnings(updated.warnings),
        }),
      ),
  ),
  delete: bindWorkflow(
    workflow<EntityKernelContext, string[]>(`${binding.entity}.delete`)
      .call("validated", async (_, { input }) => {
        const run = binding.repository.delete;
        if (!run)
          throw createAppError(
            "CONSTRAINT_VIOLATION",
            `${ENTITY_LABEL[binding.entity]} does not support delete`,
          );
        return {
          run,
          ids: input.map((id) =>
            parseSchema<S["id"], string>(binding.schemas.id, id),
          ),
        };
      })
      .commit("deleted", async ({ context }, { validated }) =>
        validated.run(context, validated.ids),
      )
      .effect("receipt", async (_, { deleted }) => {
        if (!deleted.affectedEdges)
          throw new Error(
            `${binding.entity} delete returned without affected-edge counts`,
          );
        return { ...deleted, affectedEdges: deleted.affectedEdges };
      })
      .effect("storage", async ({ context }, { receipt }) =>
        deleteDetachedObjects(context, receipt.detachedImageKeys),
      )
      .output(({ receipt }) =>
        entityBrowserMutationResultSchema.parse({
          action: "delete",
          entity: binding.entity,
          deletedReferences: receipt.deletedReferences,
          affectedEdges: receipt.affectedEdges,
          sideEffects: EMPTY_MUTATION_SIDE_EFFECTS,
        }),
      ),
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
      .effect("storage", async ({ context }, { updated }) =>
        deleteDetachedObjects(context, updated.detachedImageKeys),
      )
      .output(({ updated }) =>
        entityBrowserMutationResultSchema.parse({
          action: "bulkUpdate",
          entity: binding.entity,
          updatedReferences: updated.updatedReferences,
          sideEffects: EMPTY_MUTATION_SIDE_EFFECTS,
        }),
      ),
  ),
});
