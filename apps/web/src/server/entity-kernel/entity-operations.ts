import { entityFieldModels } from "@cubby/schemas/entity-fields";
import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";
import type { EntitySourceInput } from "@cubby/schemas/entity-source";
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
  type ListGroupSummary,
  type PaginationParams,
} from "@cubby/schemas/pagination";
import type { SearchableEntityRef } from "@cubby/schemas/search";
import { getErrorMessage } from "@cubby/shared";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { listReadRowSchema } from "~/entity/model/list-read-fields";
import { listReadFields } from "~/entity/model/list-read-schema";
import { deleteStoredObjects } from "~/server/clients/s3";
import { getDb, withTransactionDatabase } from "~/server/db/helpers";
import { runAfterCommit } from "~/server/db/helpers/core";
import { assessmentState as suggestionTable } from "~/server/db/schema";
import {
  canUpdateColumns,
  updateColumns,
} from "~/server/entity-kernel/repo/column-update";
import {
  withListEntityMedia,
  withUniversalEntityMedia,
} from "~/server/entity-kernel/repo/entity-display-image";
import {
  normalizeRecordEmoji,
  repositoryRecordInput,
  writeRecordEmoji,
  withRecordEmoji,
  recordEmojiBeforeUpdate,
  auditRecordEmoji,
  normalizeSavedRecordEmoji,
} from "~/server/entity-kernel/repo/entity-emoji";
import {
  describeUnresolvableCode,
  isShortcodeEntity,
  resolveEntityIdentity,
} from "~/server/entity-kernel/repo/entity-identity";
import {
  assertEntitySourceFieldPaths,
  entityDetailJson,
  recordEntitySources,
  sourceSnapshotCovers,
} from "~/server/entity-kernel/repo/entity-source";
import {
  isMutationSideEffectRef,
  type MutationSideEffectEvent,
  projectMutationEvent,
  runMutationSideEffectsForEntities,
  runMutationSideEffects,
} from "~/server/entity-kernel/repo/mutation-side-effects";
import { AppError, createAppError } from "~/server/errors/app-error";
import { findPgError } from "~/server/errors/db-errors";
import { withListGroupBy } from "~/server/generic/list/repo/list";
import { listTotalLabels } from "~/server/generic/list/repo/list-display-labels";
import { withChildCounts } from "~/server/generic/list/repo/list-read-adapters";
import { deferPublications } from "~/server/workflows/background-tasks/publish";
import {
  bindWorkflow,
  workflow,
  mapWorkflowValue,
} from "~/server/workflows/runtime";

import type {
  EntityBindingSchemas,
  EntityInternalId,
  EntityKernelContext,
  EntityKernelCoreBinding,
} from "./adapter";
import { resolveCollectionPatches } from "./collection-patch";
import {
  type EntityKernelEntity,
  entityBrowserMutationResultSchema,
  entityBulkUpdateResultSchema,
  entityMutationReadResultSchema,
  entityQueryResultSchema,
} from "./contracts";
import { resolveFilterTokens } from "./filter-tokens";
import {
  parseGroupBy,
  parseNesting,
  parseSchema,
  parseSorts,
} from "./list-input";

type EntityListInput<TFilters = unknown> = {
  filters: TFilters;
  sort?: { orderBy: string; direction: "asc" | "desc" }[];
  pagination?: PaginationParams;
  groupBy?: string;
  groupLevel?: number;
  nesting?: unknown;
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

/** A list page's full-filter sums with their server-worded totals. */
const aggregates = (
  entity: EntityKernelEntity,
  sums: Record<string, number> | undefined,
  groups: ListGroupSummary[] | undefined,
) => ({ sums, totalLabels: listTotalLabels(entity, sums), groups });

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
): Promise<TResult & { projectedRefs: SearchableEntityRef[] }> => {
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
      const projectedRefs = event
        ? await projectMutationEvent(transactionDb, event)
        : [];
      return { ...result, projectedRefs };
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
  projectedRefs: SearchableEntityRef[],
): Promise<void> => {
  const event = sideEffectEventFor(binding, action, entityId, source);
  if (!event) return;
  // The projections were refreshed inside the write transaction above.
  await runMutationSideEffects(ctx.db, event, undefined, {
    projection: "skip",
    projectedRefs,
  });
};

/**
 * Caller sources ride the write's transaction. A field-scoped source is
 * fingerprinted against the mutation's authoritative snapshot using the same
 * JSON normalization and field paths as a later detail read.
 */
const recordWriteSources = async <
  E extends EntityKernelEntity,
  S extends EntityBindingSchemas,
>(
  context: EntityKernelContext,
  binding: EntityKernelCoreBinding<E, S>,
  entityId: EntityInternalId<E>,
  code: string,
  sources: readonly EntitySourceInput[],
  snapshot: unknown,
): Promise<void> => {
  const detail = sources.some((source) => source.fieldPath !== undefined)
    ? entityDetailJson.parse(
        sourceSnapshotCovers(binding.entity, snapshot, sources)
          ? snapshot
          : await binding.repository.get(
              context,
              parseSchema<S["id"], string>(binding.schemas.id, code),
            ),
      )
    : undefined;
  await recordEntitySources(context.db, {
    entityKind: binding.entity,
    entityId,
    sources,
    recorder: context.actorContext,
    detail,
  });
};

const writtenCode = z.object({ id: z.string() });

type MutationReadDemand<Read extends boolean> = Read extends true
  ? { fields: readonly string[] }
  : { fields?: never };

const mutationReadFields = (entity: EntityKernelEntity, fields: unknown) => {
  const requested = z.array(z.string()).parse(fields);
  const allowed = Object.values(listReadFields(entity)).flat();
  for (const field of requested) {
    if (!allowed.includes(field))
      throw new Error(`Unknown mutation response field: ${field}`);
  }
  return requested;
};

/** Target and basis changes supersede pending suggestions in the mutation transaction. */
const supersedeWriteSuggestions = async (
  context: EntityKernelContext,
  entity: EntityKernelEntity,
  ids: readonly string[],
  changedFields: readonly string[],
): Promise<void> => {
  const dependentFields = entityFieldModels[entity].fields
    .filter((field) =>
      field.control?.suggest?.basis?.some((input) =>
        changedFields.includes(input),
      ),
    )
    .map((field) => field.key);
  if (dependentFields.length)
    await getDb(context.db)
      .update(suggestionTable)
      .set({
        status: "superseded",
        supersessionReceipt: {
          reason: "input_changed",
          evaluationId: null,
          at: new Date().toISOString(),
        },
      })
      .where(
        and(
          eq(suggestionTable.entity, entity),
          inArray(suggestionTable.recordId, ids),
          inArray(suggestionTable.field, dependentFields),
          eq(suggestionTable.status, "pending"),
        ),
      );
  if (changedFields.length) {
    await getDb(context.db)
      .update(suggestionTable)
      .set({
        status: "superseded",
        supersessionReceipt: {
          reason: "target_changed",
          evaluationId: null,
          at: new Date().toISOString(),
        },
      })
      .where(
        and(
          eq(suggestionTable.entity, entity),
          inArray(suggestionTable.recordId, ids),
          inArray(suggestionTable.field, changedFields),
          eq(suggestionTable.status, "pending"),
        ),
      );
  }
};

const buildUpdateOperation = <
  const E extends EntityKernelEntity,
  const S extends EntityBindingSchemas,
  const Read extends boolean,
>(
  binding: EntityKernelCoreBinding<E, S>,
  readMode: Read,
) =>
  bindWorkflow(
    workflow<
      EntityKernelContext,
      {
        id: string;
        data: unknown;
        sources?: EntitySourceInput[];
      } & MutationReadDemand<Read>
    >(`${binding.entity}.update`)
      .call("validated", async ({ context }, { input }) => {
        const schema = binding.schemas.updateInput;
        const read = binding.repository.updateRead;
        const fields = readMode
          ? mutationReadFields(binding.entity, input.fields)
          : undefined;
        const run = binding.repository.update;
        if (!schema || !run)
          throw createAppError(
            "CONSTRAINT_VIOLATION",
            `${ENTITY_LABEL[binding.entity]} does not support update`,
          );
        assertEntitySourceFieldPaths(binding.entity, input.sources);
        return {
          projected: fields !== undefined && read !== undefined,
          run:
            fields && read
              ? (
                  context: EntityKernelContext,
                  id: Parameters<typeof run>[1],
                  data: Parameters<typeof run>[2],
                ) => read(context, id, data, fields)
              : run,
          sources: input.sources ?? [],
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
            const data = Object.assign(
              {},
              validated.data,
              Object.fromEntries(
                await resolveCollectionPatches(
                  writeContext,
                  binding,
                  validated.id,
                  validated.data,
                ),
              ),
            );
            const updated = await validated.run(
              writeContext,
              validated.id,
              parseSchema(
                presentSchema<S["updateInput"]>(binding.schemas.updateInput),
                repositoryRecordInput(binding.entity, data),
              ),
            );
            const changedFields = Object.keys(
              z.record(z.string(), z.unknown()).parse(validated.data),
            );
            await supersedeWriteSuggestions(
              writeContext,
              binding.entity,
              [updated.entityId],
              changedFields,
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
            if (validated.sources.length > 0)
              await recordWriteSources(
                writeContext,
                binding,
                updated.entityId,
                writtenCode.parse(updated.output).id,
                validated.sources,
                updated.sourceSnapshot ?? updated.output,
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
          updated.projectedRefs,
        ),
      )
      .output(({ validated, updated }) => {
        const item = validated.projected
          ? listReadRowSchema.parse(updated.output)
          : parseSchema<S["output"], typeof updated.output>(
              binding.schemas.output,
              updated.output,
            );
        const result = {
          action: "update" as const,
          entity: binding.entity,
          item,
          sideEffects: mutationSideEffectsWithWarnings(updated.warnings),
        };
        return result;
      }),
  );

const buildEntityOperations = <
  const E extends EntityKernelEntity,
  const S extends EntityBindingSchemas,
  const Read extends boolean,
>(
  binding: EntityKernelCoreBinding<E, S>,
  readMode: Read,
) => {
  const update = buildUpdateOperation(binding, readMode);
  const updateRow = buildUpdateOperation(binding, false);
  return {
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
        .call("validated", async ({ context }, { input }) => {
          const { ids, ...repositoryFilters } = z
            .object({
              ids: z.array(z.string()).max(500).optional(),
            })
            .passthrough()
            .parse(input.filters);
          for (const id of ids ?? []) binding.schemas.id.parse(id);
          const filters = await resolveFilterTokens(
            context,
            binding.schemas.filters,
            parseSchema<S["filters"], unknown>(
              binding.schemas.filters,
              repositoryFilters,
            ),
          );
          const searchQuery = entityListSearchSchema.parse(filters).searchQuery;
          return {
            filters,
            ids,
            pagination: input.pagination ?? DEFAULT_PAGINATION,
            sorts: parseSorts(binding, input.sort, Boolean(searchQuery)),
            groupBy: parseGroupBy(binding, input.groupBy, input.groupLevel),
            nesting: parseNesting(binding, input.nesting),
          };
        })
        .call("page", async ({ context }, { validated }) => {
          return binding.repository.list(
            context,
            withListGroupBy(
              Object.assign(
                {},
                validated.filters,
                validated.ids === undefined ? {} : { ids: validated.ids },
                { nesting: validated.nesting },
              ),
              validated.groupBy,
            ),
            validated.sorts,
            validated.pagination,
          );
        })
        .call("mediaPage", async ({ context }, { page }) => ({
          ...page,
          data: await withListEntityMedia(
            context.db,
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
              withChildCounts(
                z.array(binding.schemas.list).parse(mediaPage.data),
                mediaPage.data,
              ),
              mediaPage.count,
              aggregates(
                binding.entity,
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
            ),
          }),
        ),
    ),
    create: bindWorkflow(
      workflow<
        EntityKernelContext,
        {
          data: unknown;
          sources?: EntitySourceInput[];
        } & MutationReadDemand<Read>
      >(`${binding.entity}.create`)
        .call("validated", async (_, { input }) => {
          const schema = binding.schemas.createInput;
          const read = binding.repository.createRead;
          const fields = readMode
            ? mutationReadFields(binding.entity, input.fields)
            : undefined;
          const run = binding.repository.create;
          if (!schema || !run)
            throw createAppError(
              "CONSTRAINT_VIOLATION",
              `${ENTITY_LABEL[binding.entity]} does not support create`,
            );
          assertEntitySourceFieldPaths(binding.entity, input.sources);
          return {
            projected: fields !== undefined && read !== undefined,
            run:
              fields && read
                ? (
                    context: EntityKernelContext,
                    data: Parameters<typeof run>[1],
                  ) => read(context, data, fields)
                : run,
            sources: input.sources ?? [],
            data: parseSchema(
              presentSchema<S["createInput"]>(schema),
              normalizeRecordEmoji(binding.entity, input.data),
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
              if (validated.sources.length > 0)
                await recordWriteSources(
                  writeContext,
                  binding,
                  created.entityId,
                  writtenCode.parse(created.output).id,
                  validated.sources,
                  created.sourceSnapshot ?? created.output,
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
            created.projectedRefs,
          ),
        )
        .output(({ validated, created }) => {
          const item = validated.projected
            ? listReadRowSchema.parse(created.output)
            : parseSchema<S["output"], typeof created.output>(
                binding.schemas.output,
                created.output,
              );
          const result = {
            action: "create" as const,
            entity: binding.entity,
            item,
            sideEffects: mutationSideEffectsWithWarnings(created.warnings),
          };
          return result;
        }),
    ),
    update,
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
          if (!schema || !binding.repository.update)
            throw createAppError(
              "CONSTRAINT_VIOLATION",
              `${ENTITY_LABEL[binding.entity]} does not support bulk update`,
            );
          const data = parseSchema(
            presentSchema<S["bulkUpdateInput"]>(schema),
            input.data,
          );
          if (
            !Object.values(z.record(z.string(), z.unknown()).parse(data)).some(
              (value) => value !== undefined,
            )
          )
            throw createAppError(
              "CONSTRAINT_VIOLATION",
              "A bulk patch must supply at least one field.",
            );
          return { ids: input.ids, data };
        })
        .commit("updated", async ({ context }, { validated }) => {
          const deferred = deferPublications();
          let offending: string | undefined;
          try {
            const updated = await withTransactionDatabase(
              context.db,
              async (db) => {
                const writeContext = {
                  ...context,
                  db,
                  services: {
                    ...context.services,
                    recipeCosting: context.services.recipeCosting.bindTo(
                      db,
                      deferred.publish,
                    ),
                  },
                };
                if (
                  canUpdateColumns(
                    binding.entity,
                    validated.data,
                    binding.repository.updatePolicy,
                  )
                ) {
                  const result = await updateColumns(
                    writeContext,
                    binding.entity,
                    validated.ids,
                    validated.data,
                  );
                  await supersedeWriteSuggestions(
                    writeContext,
                    binding.entity,
                    result.updatedIds,
                    Object.keys(
                      z.record(z.string(), z.unknown()).parse(validated.data),
                    ),
                  );
                  const events = result.updatedIds.flatMap(
                    (id): MutationSideEffectEvent[] => {
                      const ref = parseEntityRef<ShortcodeEntity>(
                        binding.entity,
                        id,
                      );
                      return isMutationSideEffectRef(ref)
                        ? [
                            {
                              action: "updated",
                              entity: ref,
                              source: `${binding.entity}.bulkUpdate`,
                            },
                          ]
                        : [];
                    },
                  );
                  await runMutationSideEffectsForEntities(db, events);
                } else {
                  for (const id of validated.ids) {
                    offending = id;
                    const parsedId = parseSchema<S["id"], string>(
                      binding.schemas.id,
                      id,
                    );
                    const data = Object.assign(
                      {},
                      validated.data,
                      Object.fromEntries(
                        await resolveCollectionPatches(
                          writeContext,
                          binding,
                          parsedId,
                          validated.data,
                          { bulk: true },
                        ),
                      ),
                    );
                    await updateRow(writeContext, { id, data });
                  }
                }
                return {
                  updatedReferences: validated.ids.map((id) => ({
                    entity: binding.entity,
                    id,
                  })),
                };
              },
            );
            await deferred.flush(context.db);
            return updated;
          } catch (error) {
            const pg = findPgError(error);
            const message = `Bulk ${binding.entity} update failed${offending ? ` at row ${offending}` : ""}; selected rows: ${validated.ids.join(", ")}. ${pg ? `SQLSTATE ${pg.code}: ${pg.message ?? ""} ${pg.detail ?? ""}. ` : ""}${getErrorMessage(error)}`;
            if (error instanceof AppError)
              throw new AppError({
                code: error.code,
                reason: error.reason,
                blockers: error.blockers,
                message,
                cause: error,
              });
            throw new Error(message, { cause: error });
          }
        })
        .output(({ updated }) =>
          entityBulkUpdateResultSchema.parse({
            action: "bulkUpdate",
            entity: binding.entity,
            updatedReferences: updated.updatedReferences,
            sideEffects: EMPTY_MUTATION_SIDE_EFFECTS,
          }),
        ),
    ),
  };
};

/** Both output contracts retain the same executable graph and dependencies. */
export const defineEntityOperations = <
  const E extends EntityKernelEntity,
  const S extends EntityBindingSchemas,
>(
  binding: EntityKernelCoreBinding<E, S>,
) => {
  const operations = buildEntityOperations(binding, false);
  const reads = buildEntityOperations(binding, true);
  return {
    ...operations,
    create: bindWorkflow({
      ...operations.create.definition,
      output: mapWorkflowValue(operations.create.definition.output, (result) =>
        entityBrowserMutationResultSchema.parse(result),
      ),
    }),
    update: bindWorkflow({
      ...operations.update.definition,
      output: mapWorkflowValue(operations.update.definition.output, (result) =>
        entityBrowserMutationResultSchema.parse(result),
      ),
    }),
    createRead: bindWorkflow({
      ...reads.create.definition,
      output: mapWorkflowValue(reads.create.definition.output, (result) =>
        entityMutationReadResultSchema.parse(result),
      ),
    }),
    updateRead: bindWorkflow({
      ...reads.update.definition,
      output: mapWorkflowValue(reads.update.definition.output, (result) =>
        entityMutationReadResultSchema.parse(result),
      ),
    }),
  };
};
