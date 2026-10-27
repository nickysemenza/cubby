import { entityMutationItem } from "@cubby/schemas/entity-mutation";
import {
  ENTITY_LABEL,
  ENTITY_NOT_FOUND_REASON,
} from "@cubby/schemas/identifiers";
import {
  EMPTY_MUTATION_SIDE_EFFECTS,
  mutationSideEffectsWithWarnings,
} from "@cubby/schemas/mutation-side-effects";
import {
  buildPaginatedResponse,
  DEFAULT_PAGE_SIZE,
  listGroupSummarySchema,
  listGroupMembershipSchema,
  type ListGroupSummary,
  type ListGroupBy,
  type ListResultMembership,
  type PaginationParams,
} from "@cubby/schemas/pagination";
import { getErrorMessage } from "@cubby/shared";
import { z } from "zod";

import { deleteStoredObjects } from "~/server/clients/s3";
import { withTransactionDatabase } from "~/server/db/helpers";
import { runAfterCommit } from "~/server/db/helpers/core";
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
  recordEmojiBeforeUpdate,
  auditRecordEmoji,
  normalizeSavedRecordEmoji,
} from "~/server/entity-kernel/repo/entity-emoji";
import {
  describeUnresolvableCode,
  isShortcodeEntity,
  resolveEntityIdentity,
} from "~/server/entity-kernel/repo/entity-identity";
import { AppError, createAppError } from "~/server/errors/app-error";
import { findPgError } from "~/server/errors/db-errors";
import { recordChange } from "~/server/generic/changes/repo/change";
import {
  loadPublicFieldReadContexts,
  publicFieldEnvelopeRows,
} from "~/server/generic/derived/repo/public-read";
import { detailBreadcrumb } from "~/server/generic/entity-detail/repo/detail-breadcrumb";
import { withListGroupBy } from "~/server/generic/list/repo/list";
import { listTotalLabels } from "~/server/generic/list/repo/list-display-labels";
import { withChildCounts } from "~/server/generic/list/repo/list-read-adapters";
import { listReadSchema } from "~/server/generic/list/repo/list-read-schema";
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
import { readMutationReceiptFields } from "./repo/mutation-receipt";

type EntityListInput<TFilters = unknown> = {
  filters: TFilters;
  sort?: { orderBy: string; direction: "asc" | "desc" }[];
  pagination?: PaginationParams;
  groupBy?: ListGroupBy[];
  nesting?: unknown;
  resultMembership?: ListResultMembership;
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
  incompleteSums?: string[],
) => ({
  sums,
  totalLabels: listTotalLabels(entity, sums, incompleteSums),
  groups,
  incompleteSums,
});

/**
 * Commit authoritative writes and durable refresh capture together.
 */
const writeWithChange = async <
  E extends EntityKernelEntity,
  S extends EntityBindingSchemas,
  TResult extends { entityId: EntityInternalId<E> },
>(
  context: EntityKernelContext,
  binding: EntityKernelCoreBinding<E, S>,
  write: (context: EntityKernelContext) => Promise<TResult>,
): Promise<TResult> => {
  // Every declared write, including identity-only entities, uses the transaction-bound context.
  // Everything the adapter reaches through the context must run on the
  // transaction: a service still bound to the request pool would UPDATE a row
  // this transaction holds and wait on it forever. Its Job intents are
  // saved in the same transaction; queue wakes wait for commit.

  const result = await withTransactionDatabase(
    context.db,
    async (transactionDb) => {
      const result = await write({
        ...context,
        db: transactionDb,
        services: {
          ...context.services,
          recipeCosting: context.services.recipeCosting.bindTo(transactionDb),
        },
      });
      // Known source intent is unconditional; the transaction key coalesces audit writes.
      await recordChange(transactionDb, {
        kind: "source",
        categories: [binding.entity],
      });
      return result;
    },
  );

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

type MutationReadDemand<Read extends boolean> = Read extends true
  ? { fields: readonly string[] }
  : { fields?: never };

const mutationReadFields = (entity: EntityKernelEntity, fields: unknown) => {
  const requested = z.array(z.string()).parse(fields);
  const allowed = Object.keys(listReadSchema(entity).shape);
  for (const field of requested) {
    if (!allowed.includes(field))
      throw new Error(`Unknown mutation response field: ${field}`);
  }
  return requested;
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
      } & MutationReadDemand<Read>
    >(`${binding.entity}.update`)
      .call("validated", async ({ context }, { input }) => {
        const schema = binding.schemas.updateInput;
        const read = binding.repository.updateRead;
        const fields = readMode
          ? mutationReadFields(binding.entity, input.fields)
          : undefined;
        const run = binding.repository.update;
        if (!schema || !run || !read)
          throw createAppError(
            "CONSTRAINT_VIOLATION",
            `${ENTITY_LABEL[binding.entity]} does not support update`,
          );
        return {
          responseFields: fields,
          submittedFields: Object.keys(
            z.record(z.string(), z.unknown()).parse(input.data),
          ),
          run: (
            context: EntityKernelContext,
            id: Parameters<typeof run>[1],
            data: Parameters<typeof run>[2],
          ) => read(context, id, data, ["id"]),
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
        writeWithChange(context, binding, async (writeContext) => {
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
          const receipt = await readMutationReceiptFields(
            writeContext.db,
            binding.entity,
            updated.entityId,
            validated.submittedFields,
          );
          return {
            ...updated,
            output: {
              id: receipt.item.id,
              ...Object.fromEntries(
                Object.entries(receipt.item).filter(
                  ([key]) =>
                    key !== "id" &&
                    validated.submittedFields.includes(key) &&
                    (!validated.responseFields ||
                      validated.responseFields.includes(key)),
                ),
              ),
            },
          };
        }),
      )
      .effect("storage", async ({ context }, { updated }) =>
        deleteDetachedObjects(context, updated.detachedImageKeys),
      )
      .output(({ validated, updated }) => {
        const item = entityMutationItem.parse(updated.output);
        const result = {
          action: "update" as const,
          entity: binding.entity,
          item,
          appliedFields: validated.submittedFields,
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
          const fieldReads = loadPublicFieldReadContexts(
            context.db,
            binding.entity,
            [input.id],
          );
          fieldReads.catch(() => {
            // SILENT: The promise is awaited below; prevent an unhandled rejection on an early not-found response.
          });
          const item = await binding.repository.get(context, id);
          if (item !== null)
            return {
              item,
              fieldReads,
              redirectedFrom: null,
              missingMessage: null,
            };
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
              fieldReads: loadPublicFieldReadContexts(
                context.db,
                binding.entity,
                [identity.canonicalShortcode],
              ),
              redirectedFrom: identity.requested,
              missingMessage: null,
            };
          return {
            item: null,
            fieldReads,
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
        .call("media", async ({ context }, { found }) => {
          if (found.item === null) return null;
          const [item] = await withUniversalEntityMedia(
            context.db,
            binding.entity,
            [found.item],
            true,
          );
          const breadcrumb =
            item === undefined
              ? undefined
              : await detailBreadcrumb(context.db, binding.entity, item);
          return {
            ...item,
            ...(breadcrumb === undefined ? {} : { breadcrumb }),
            redirectedFrom: found.redirectedFrom,
          };
        })
        .call("enveloped", async ({ context }, { found, media }) =>
          media === null
            ? null
            : (
                await publicFieldEnvelopeRows({
                  db: context.db,
                  entity: binding.entity,
                  schema: binding.schemas.detail,
                  rows: [media],
                  contexts: await found.fieldReads,
                })
              )[0],
        )
        .output(({ input, found, media, enveloped }) => {
          if (media === null && input.missing !== "null")
            throw createAppError(
              ENTITY_NOT_FOUND_REASON[binding.entity],
              found.missingMessage ??
                `${ENTITY_LABEL[binding.entity]} ${input.id} not found`,
            );
          return entityQueryResultSchema.parse({
            action: "get",
            entity: binding.entity,
            item: enveloped ?? null,
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
            groupBy: parseGroupBy(binding, input.groupBy),
            nesting: parseNesting(binding, input.nesting),
            resultMembership: input.resultMembership,
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
                {
                  nesting: validated.nesting,
                  resultMembership: validated.resultMembership,
                },
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
        .call("enveloped", async ({ context }, { mediaPage }) =>
          publicFieldEnvelopeRows({
            db: context.db,
            entity: binding.entity,
            schema: binding.schemas.list,
            rows: mediaPage.data,
            contexts: mediaPage.fieldReads,
          }),
        )
        .output(({ validated, mediaPage, enveloped }) =>
          entityQueryResultSchema.parse({
            action: "list",
            entity: binding.entity,
            ...buildPaginatedResponse(
              validated.pagination,
              withChildCounts(enveloped, mediaPage.data),
              mediaPage.count,
              {
                unresolvedCount:
                  "unresolvedCount" in mediaPage
                    ? z
                        .number()
                        .int()
                        .nonnegative()
                        .optional()
                        .parse(mediaPage.unresolvedCount)
                    : undefined,
                ...aggregates(
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
                  "incompleteSums" in mediaPage
                    ? z
                        .array(z.string())
                        .optional()
                        .parse(mediaPage.incompleteSums)
                    : undefined,
                ),
                memberships:
                  "memberships" in mediaPage
                    ? z
                        .array(listGroupMembershipSchema)
                        .optional()
                        .parse(mediaPage.memberships)
                    : undefined,
                membershipCount:
                  "membershipCount" in mediaPage
                    ? z
                        .number()
                        .int()
                        .nonnegative()
                        .optional()
                        .parse(mediaPage.membershipCount)
                    : undefined,
              },
            ),
          }),
        ),
    ),
    create: bindWorkflow(
      workflow<
        EntityKernelContext,
        {
          data: unknown;
        } & MutationReadDemand<Read>
      >(`${binding.entity}.create`)
        .call("validated", async (_, { input }) => {
          const schema = binding.schemas.createInput;
          const read = binding.repository.createRead;
          const fields = readMode
            ? mutationReadFields(binding.entity, input.fields)
            : undefined;
          const run = binding.repository.create;
          if (!schema || !run || !read)
            throw createAppError(
              "CONSTRAINT_VIOLATION",
              `${ENTITY_LABEL[binding.entity]} does not support create`,
            );
          return {
            responseFields: fields,
            submittedFields: Object.keys(
              z.record(z.string(), z.unknown()).parse(input.data),
            ),
            run: (
              context: EntityKernelContext,
              data: Parameters<typeof run>[1],
            ) => read(context, data, ["id"]),
            data: parseSchema(
              presentSchema<S["createInput"]>(schema),
              normalizeRecordEmoji(binding.entity, input.data),
            ),
          };
        })
        .commit("created", async ({ context }, { validated }) =>
          writeWithChange(context, binding, async (writeContext) => {
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
            const receipt = await readMutationReceiptFields(
              writeContext.db,
              binding.entity,
              created.entityId,
              validated.submittedFields,
            );
            return {
              ...created,
              output: {
                id: receipt.item.id,
                ...Object.fromEntries(
                  Object.entries(receipt.item).filter(
                    ([key]) =>
                      key !== "id" &&
                      validated.submittedFields.includes(key) &&
                      (!validated.responseFields ||
                        validated.responseFields.includes(key)),
                  ),
                ),
              },
            };
          }),
        )
        .effect("storage", async ({ context }, { created }) =>
          deleteDetachedObjects(context, created.detachedImageKeys),
        )
        .output(({ validated, created }) => {
          const item = entityMutationItem.parse(created.output);
          const result = {
            action: "create" as const,
            entity: binding.entity,
            item,
            appliedFields: validated.submittedFields,
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
                    recipeCosting: context.services.recipeCosting.bindTo(db),
                  },
                };
                if (
                  canUpdateColumns(
                    binding.entity,
                    validated.data,
                    binding.repository.updatePolicy,
                  )
                ) {
                  await updateColumns(
                    writeContext,
                    binding.entity,
                    validated.ids,
                    validated.data,
                  );
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
                await recordChange(db, {
                  kind: "source",
                  categories: [binding.entity],
                });
                return {
                  updatedReferences: validated.ids.map((id) => ({
                    entity: binding.entity,
                    id,
                  })),
                };
              },
            );

            return updated;
          } catch (error) {
            const pg = findPgError(error);
            const message = `Bulk ${binding.entity} update failed${offending ? ` at row ${offending}` : ""}; selected rows: ${validated.ids.join(", ")}. ${pg ? `SQLSTATE ${pg.code}: ${pg.message ?? ""} ${pg.detail ?? ""}. ` : ""}${getErrorMessage(error)}`;
            if (error instanceof AppError)
              throw new AppError({
                code: error.code,
                reason: error.reason,
                blockers: error.blockers,
                blockersIncomplete: error.blockersIncomplete,
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
