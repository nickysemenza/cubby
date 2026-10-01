/**
 * One repository shape for every kernel entity.
 *
 * `defineRepository(entity, spec)` is the whole kernel binding: the generated
 * binding module (`entity-kernel-bindings.gen.ts`) imports each entity's
 * repository export and hands it to the kernel as is. Methods take the kernel
 * context natively (`(ctx, …)`); everything a declaration already says is
 * derived rather than restated:
 *
 * - schemas and sort come from the generated roster;
 * - the kernel actions come from the declaration (`lifecycle: "readOnly"`
 *   exposes get/list only, whatever the spec supplies);
 * - `get` defaults to the reader (`fetchById` + `mapper`) by shortcode;
 * - `delete` defaults to the declared `lifecycle.delete` edge policy plus
 *   `deleteHooks`;
 * - a create/update that returns the bare output has its internal id
 *   resolved from the output's public id.
 *
 * The kernel owns the write transaction: create/update run inside
 * `writeWithProjections` and delete inside `executeDeleteWithEffects`, and a
 * repository receives that transaction-bound `ctx.db` (services rebound to
 * it). A repository never opens a transaction on another handle — a
 * pool-bound statement against a row the kernel's transaction holds waits
 * forever (docs/agents/domain-rules.md). Nested `withTransaction` calls on
 * `ctx.db` become savepoints.
 */
import type { ActorContext } from "@cubby/schemas/context";
import {
  type AuditableEntity,
  entityManifest,
  type ShortcodeEntity,
} from "@cubby/schemas/entity-manifest";
import { generatedEntitySort } from "@cubby/schemas/entity-sort";
import {
  ENTITY_LABEL,
  ENTITY_NOT_FOUND_REASON,
  type EntityId,
} from "@cubby/schemas/identifiers";
import type { PaginationParams, SortParams } from "@cubby/schemas/pagination";
import type { AnyColumn, InferSelectModel } from "drizzle-orm";
import type { PgTable, PgUpdateSetSource } from "drizzle-orm/pg-core";
import { type output as ZodOutput, type ZodSchema, z } from "zod";

import { deferPublications } from "~/server/background-tasks/publish";
import type { Database, DrizzleTransaction } from "~/server/db";
import type {
  EntityBindingSchemas,
  EntityKernelBulkUpdateResult,
  EntityKernelContext,
  EntityKernelDeleteResult,
  EntityLifecycleContract,
  EntityMergePort,
  EntityRepository,
  EntityRepositoryWriteResult,
  EntitySortContract,
} from "~/server/entity-kernel/adapter";
import { deletedWithImages } from "~/server/entity-kernel/adapter";
import { createAppError } from "~/server/errors/app-error";
import {
  ENTITY_SCHEMA_BINDINGS,
  type EntitySchemaBindingEntity,
  type EntitySchemaBindingMap,
} from "~/server/generated/entity-bindings.gen";
import { generatedEntityKernelContractCases } from "~/server/generated/entity-kernel-entities.gen";
import { computeChanges, logAuditEntry } from "~/server/repo/audit-log";
import {
  updateLiveAndReturn,
  withTransactionOn,
} from "~/server/repo/database-helpers";
import { type RemovableEntity } from "~/server/repo/removal/core";
import { executeDeleteWithEffects } from "~/server/repo/removal/delete-effects";
import {
  deleteByPolicy,
  type DeleteHooks,
} from "~/server/repo/removal/dispositions";
import {
  resolveLiveShortcode,
  resolveOrThrow,
} from "~/server/repo/shortcode-resolver";

import type { ListProjection, ListReadPage } from "./list-projection";

/* -------------------------------------------------------------------------- */
/* Reads                                                                       */
/* -------------------------------------------------------------------------- */

type ReaderDb = Database | DrizzleTransaction;

interface EntityReaderConfig<
  TRow,
  TOut,
  E extends ShortcodeEntity,
  TDb extends ReaderDb = Database,
> {
  /** Drives the 404 message and the shortcode this reader resolves. */
  entity: E;
  /** Relations-loaded fetch of a live row by id; `undefined` when absent. */
  fetchById: (db: TDb, id: EntityId<E>) => Promise<TRow | undefined>;
  /** DB row → API shape. Async to support mappers that do a follow-up query. */
  fromDB: (db: TDb, row: TRow) => TOut | Promise<TOut>;
}

export interface EntityReader<
  TOut,
  E extends ShortcodeEntity,
  TDb extends ReaderDb = Database,
> {
  /** Fetch by id, throwing `ENTITY_NOT_FOUND_REASON[entity]` when there is no live row. */
  getByID: (db: TDb, id: EntityId<E>) => Promise<TOut>;
  /** Fetch by id, returning `null` when there is no live row. */
  getByIDOrNull: (db: TDb, id: EntityId<E>) => Promise<TOut | null>;
  /**
   * Fetch by PUBLIC id — the shortcode URLs and MCP speak — returning `null`
   * when the code is malformed, belongs to another entity, or names a row
   * that no longer lives.
   */
  getByShortcode: (db: TDb, shortcode: string) => Promise<TOut | null>;
}

/**
 * The live-row read every repository shares: fetch by id (with relations) →
 * null-or-404 → map. A repository's `get` is its `getByShortcode`.
 *
 * `TDb` defaults to `Database`: `project`'s and `task`'s mappers fan out to
 * loaders typed `(db: Database, …)`, which `strictFunctionTypes` would force
 * to widen transitively; only a reader shared with an audited update
 * (`createEntityCrud`) instantiates the union.
 */
export function createEntityReader<
  TRow,
  TOut,
  E extends ShortcodeEntity,
  TDb extends ReaderDb = Database,
>(config: EntityReaderConfig<TRow, TOut, E, TDb>): EntityReader<TOut, E, TDb> {
  const getByIDOrNull = async (
    db: TDb,
    id: EntityId<E>,
  ): Promise<TOut | null> => {
    const row = await config.fetchById(db, id);
    return row ? config.fromDB(db, row) : null;
  };

  const getByID = async (db: TDb, id: EntityId<E>): Promise<TOut> => {
    const result = await getByIDOrNull(db, id);
    if (result === null) {
      throw createAppError(
        ENTITY_NOT_FOUND_REASON[config.entity],
        `${ENTITY_LABEL[config.entity]} ${id} not found`,
      );
    }
    return result;
  };

  const getByShortcode = async (
    db: TDb,
    shortcode: string,
  ): Promise<TOut | null> => {
    // `resolveLiveShortcode` pins the entity, so another entity's (valid) code
    // resolves to null here rather than to a uuid of the wrong type.
    const id = await resolveLiveShortcode(db, shortcode, config.entity);
    return id === null ? null : getByIDOrNull(db, id);
  };

  return { getByID, getByIDOrNull, getByShortcode };
}

/* -------------------------------------------------------------------------- */
/* Audited column update                                                       */
/* -------------------------------------------------------------------------- */

/** A soft-deletable table the audited update can write by id. */
type CrudTable = PgTable & { id: AnyColumn; deletedAt: AnyColumn };

interface EntityCrudConfig<
  TTable extends CrudTable,
  TRow extends object,
  TOut,
  TUpdate,
  E extends AuditableEntity & ShortcodeEntity,
  TRelKey extends string,
> extends Omit<EntityReaderConfig<TRow, TOut, E, ReaderDb>, "entity"> {
  table: TTable;
  entity: E;
  /** Column values to write; `before` is the live row, for derived values. */
  toUpdate: (data: TUpdate, before: TRow) => PgUpdateSetSource<TTable>;
  /** Fields recorded in the audit diff: columns, or keys of `relations`. */
  auditUpdateFields: readonly (
    | Extract<keyof TRow, keyof InferSelectModel<TTable>>
    | TRelKey
  )[];
  /**
   * Runs first in the update transaction, before the before-state is read:
   * take a row lock and refuse transitions that depend on the stored state.
   */
  prepare?: (
    tx: DrizzleTransaction,
    id: EntityId<E>,
    data: TUpdate,
  ) => Promise<void>;
  /**
   * Id sets that are audited as fields but are not columns of `table` (a link
   * set, a child list). `read` runs before and after the column UPDATE and
   * both snapshots join the diff; `write` applies the update's relation
   * changes between the first read and the UPDATE.
   */
  relations?: {
    read: (
      tx: DrizzleTransaction,
      id: EntityId<E>,
    ) => Promise<RelationSnapshot<TRelKey>>;
    write?: (
      tx: DrizzleTransaction,
      id: EntityId<E>,
      data: TUpdate,
    ) => Promise<void>;
  };
}

export interface EntityCrud<
  TOut,
  TUpdate,
  E extends AuditableEntity & ShortcodeEntity,
> extends EntityReader<TOut, E, ReaderDb> {
  /**
   * Diff-audited column update, atomic end to end: before-state → UPDATE →
   * audit entry → re-read, all on one transaction (joined when the caller
   * already holds one, e.g. the kernel's). Not serialized — two concurrent
   * updates both diff against the same before-state; last write wins, which
   * a single-household tool accepts rather than paying a row lock per write.
   */
  update: (
    db: ReaderDb,
    id: EntityId<E>,
    data: TUpdate,
    actor: ActorContext,
  ) => Promise<TOut>;
}

/**
 * The collections an entity's `relations` hook reports, keyed by audited
 * field: id sets or row lists, compared structurally by the audit diff.
 */
type RelationSnapshot<TKey extends string> = Partial<
  Record<TKey, readonly unknown[]>
>;

/** {@link createEntityReader} plus the diff-audited column update. */
export function createEntityCrud<
  TTable extends CrudTable,
  TRow extends object,
  TOut,
  TUpdate,
  E extends AuditableEntity & ShortcodeEntity,
  TRelKey extends string = never,
>(
  config: EntityCrudConfig<TTable, TRow, TOut, TUpdate, E, TRelKey>,
): EntityCrud<TOut, TUpdate, E> {
  const reader = createEntityReader<TRow, TOut, E, ReaderDb>(config);
  const update = (
    db: ReaderDb,
    id: EntityId<E>,
    data: TUpdate,
    actor: ActorContext,
  ): Promise<TOut> =>
    withTransactionOn(db, async (tx) => {
      await config.prepare?.(tx, id, data);
      const before = await config.fetchById(tx, id);
      if (!before) {
        throw createAppError(
          ENTITY_NOT_FOUND_REASON[config.entity],
          `${ENTITY_LABEL[config.entity]} ${id} not found`,
        );
      }
      const relationsBefore: RelationSnapshot<TRelKey> =
        (await config.relations?.read(tx, id)) ?? {};
      await config.relations?.write?.(tx, id, data);
      const updated = await updateLiveAndReturn(
        tx,
        config.table,
        config.toUpdate(data, before),
        id,
      );
      if (entityManifest[config.entity].auditable) {
        const relationsAfter: RelationSnapshot<TRelKey> =
          (await config.relations?.read(tx, id)) ?? {};
        // The fetch may carry relations the UPDATE's returned row lacks;
        // overlaying keeps the richer row and the exact post-write scalars.
        const changes = computeChanges<TRow & RelationSnapshot<TRelKey>>(
          { ...before, ...relationsBefore },
          { ...before, ...updated, ...relationsAfter },
          [...config.auditUpdateFields],
        );
        if (changes)
          await logAuditEntry(tx, actor, {
            entityKind: config.entity,
            entityId: id,
            action: "update",
            changes,
          });
      }
      // Re-read on `tx`: the new state is uncommitted, so another pool
      // connection would neither see it nor be free to.
      return reader.getByID(tx, id);
    });
  return { ...reader, update };
}

/* -------------------------------------------------------------------------- */
/* defineRepository                                                            */
/* -------------------------------------------------------------------------- */

/** A `(db, …args)` repository function as a kernel method `(ctx, …args)`. */
export const onDb =
  <TArgs extends readonly unknown[], TResult>(
    fn: (db: Database, ...args: TArgs) => TResult,
  ) =>
  (ctx: EntityKernelContext, ...args: TArgs): TResult =>
    fn(ctx.db, ...args);

/**
 * A `(db, filters, sorts, pagination)` list as a kernel `list`. Only those
 * four are forwarded: the kernel's fifth argument is `groupBy`, which a list
 * that takes a `readIntent` fifth must never receive.
 */
export const listOn =
  <TFilters, TResult>(
    fn: (
      db: Database,
      filters: TFilters,
      sorts: SortParams[],
      pagination: PaginationParams,
    ) => TResult,
  ) =>
  (
    ctx: EntityKernelContext,
    filters: TFilters,
    sorts: SortParams[],
    pagination: PaginationParams,
  ): TResult =>
    fn(ctx.db, filters, sorts, pagination);

/** Non-grouping staged reads receive projection, never the kernel's trailing groupBy as readIntent. */
export const listReadOn =
  <TFilters, TResult>(
    fn: (
      db: Database,
      filters: TFilters,
      sorts: SortParams[],
      pagination: PaginationParams,
      projection: ListProjection,
    ) => TResult,
  ) =>
  (
    ctx: EntityKernelContext,
    filters: TFilters,
    sorts: SortParams[],
    pagination: PaginationParams,
    projection: ListProjection,
  ): TResult =>
    fn(ctx.db, filters, sorts, pagination, projection);

/** A `(db, …args, actor)` repository write as a kernel method `(ctx, …args)`. */
export const asActor =
  <TArgs extends readonly unknown[], TResult>(
    fn: (db: Database, ...args: [...TArgs, ActorContext]) => TResult,
  ) =>
  (ctx: EntityKernelContext, ...args: TArgs): TResult =>
    fn(ctx.db, ...args, ctx.actorContext);

type SchemasFor<E extends EntitySchemaBindingEntity> =
  EntitySchemaBindingMap[E];
type Present<S> = ZodOutput<Extract<S, ZodSchema>>;

type KernelEntity = keyof typeof generatedEntityKernelContractCases &
  EntitySchemaBindingEntity;

/**
 * A create/update result: the full write result, or the bare public output
 * whose `id` (shortcode) the repository resolves to the internal id.
 */
type Written<E extends KernelEntity> =
  | EntityRepositoryWriteResult<E, SchemasFor<E>>
  | ZodOutput<SchemasFor<E>["output"]>;

/** What an entity-specific delete reports; ids default to the requested. */
type DeleteOutcome = {
  /** Public ids actually removed, when that differs from the request. */
  removed?: readonly string[];
  detachedImageKeys?: string[];
  deletedImageShortcodes?: readonly string[];
} | void;

export interface RepositorySpec<
  E extends KernelEntity,
  SMergeInput extends ZodSchema = z.ZodNever,
  SMergeOutput extends ZodSchema = z.ZodNever,
  TMergeItem = never,
  TMergeSummary = never,
> {
  /** Declared delete/merge edge policies; `{ delete: {} }` when omitted. */
  lifecycle?: EntityLifecycleContract;
  listRead?: EntityRepository<E, SchemasFor<E>>["listRead"];
  listSummary?: EntityRepository<E, SchemasFor<E>>["listSummary"];
  /** `false` when writes have no projections or dependents to refresh. */
  sideEffects?: boolean;
  get: (
    ctx: EntityKernelContext,
    id: ZodOutput<SchemasFor<E>["id"]>,
  ) => Promise<ZodOutput<SchemasFor<E>["repositoryDetail"]> | null>;
  list: (
    ctx: EntityKernelContext,
    filters: ZodOutput<SchemasFor<E>["filters"]>,
    sorts: Parameters<EntityRepositoryListFn<E>>[2],
    pagination: Parameters<EntityRepositoryListFn<E>>[3],
    groupBy?: string,
  ) => ReturnType<EntityRepositoryListFn<E>>;
  create?: (
    ctx: EntityKernelContext,
    data: Present<SchemasFor<E>["createInput"]>,
  ) => Promise<Written<E>>;
  update?: (
    ctx: EntityKernelContext,
    id: ZodOutput<SchemasFor<E>["id"]>,
    data: Present<SchemasFor<E>["updateInput"]>,
  ) => Promise<Written<E>>;
  bulkUpdate?: (
    ctx: EntityKernelContext,
    ids: ZodOutput<SchemasFor<E>["id"]>[],
    data: Present<SchemasFor<E>["bulkUpdateInput"]>,
  ) => Promise<EntityKernelBulkUpdateResult<E>>;
  /**
   * An entity-specific delete. Omit it to delete by the declared
   * `lifecycle.delete` policy with `deleteHooks` and `afterDelete`.
   */
  delete?: (
    ctx: EntityKernelContext,
    ids: ZodOutput<SchemasFor<E>["id"]>[],
  ) => Promise<DeleteOutcome>;
  deleteHooks?: DeleteHooks<Extract<E, RemovableEntity>>;
  /** In-transaction follow-ups after the policy delete (projections, costs). */
  afterDelete?: (
    ctx: EntityKernelContext,
    ids: EntityId<Extract<E, RemovableEntity>>[],
  ) => Promise<void>;
  merge?: EntityMergePort<
    E,
    SMergeInput,
    SMergeOutput,
    TMergeItem,
    TMergeSummary
  >;
}

type EntityRepositoryListFn<E extends KernelEntity> = (
  ctx: EntityKernelContext,
  filters: ZodOutput<SchemasFor<E>["filters"]>,
  sorts: SortParams[],
  pagination: PaginationParams,
  groupBy?: string,
) => Promise<ListReadPage<ZodOutput<SchemasFor<E>["repositoryList"]>>>;

const sortFor = (entity: string): EntitySortContract => {
  // SAFETY: `generatedEntitySort` is keyed by `Entity`; a kernel entity
  // without a declared `model.sort` is refused on the next line.
  const declared = (
    generatedEntitySort as Record<
      string,
      {
        fields: readonly [string, ...string[]];
        default: string;
        direction: "asc" | "desc";
        groupable: readonly string[];
      }
    >
  )[entity];
  if (declared === undefined)
    throw new Error(`${entity} has no generated model.sort.`);
  return {
    fields: declared.fields,
    default: declared.default,
    direction: declared.direction,
    // An empty `groupable` stays undefined so the kernel falls back to every
    // sortable field (`binding.sort.groupable ?? binding.sort.fields`).
    // SAFETY: the length check confirms the non-empty tuple.
    groupable:
      declared.groupable.length > 0
        ? (declared.groupable as readonly [string, ...string[]])
        : undefined,
  };
};

const publicIdSchema = z.object({ id: z.string() });
const isWriteResult = <E extends KernelEntity>(
  result: Written<E>,
): result is EntityRepositoryWriteResult<E, SchemasFor<E>> =>
  typeof result === "object" &&
  result !== null &&
  "output" in result &&
  "entityId" in result;

/**
 * Declare an entity's repository — and with it the kernel binding. See the
 * module header for what is derived from the declaration.
 */
export function defineRepository<
  const E extends KernelEntity,
  SMergeInput extends ZodSchema = z.ZodNever,
  SMergeOutput extends ZodSchema = z.ZodNever,
  TMergeItem = never,
  TMergeSummary = never,
>(
  entity: E,
  spec: RepositorySpec<E, SMergeInput, SMergeOutput, TMergeItem, TMergeSummary>,
) {
  const actions: readonly string[] =
    generatedEntityKernelContractCases[entity].actions;
  const declared = (action: string) => actions.includes(action);
  const lifecycle: EntityLifecycleContract = spec.lifecycle ?? { delete: {} };
  // SAFETY: only an auditable shortcode entity declares a delete, and
  // `repository.delete` below exists only for an entity that declares one.
  const removable = entity as Extract<E, RemovableEntity>;

  const written = async (
    ctx: EntityKernelContext,
    result: Written<E>,
  ): Promise<EntityRepositoryWriteResult<E, SchemasFor<E>>> => {
    if (isWriteResult(result)) return result;
    const { id } = publicIdSchema.parse(result);
    return {
      output: result,
      // SAFETY: a kernel entity with a create/update contract is a shortcode
      // entity (the compiler refuses a contract without one).
      entityId: (await resolveOrThrow(
        ctx.db,
        entity as E & ShortcodeEntity,
        id,
      )) as EntityId<E>,
    };
  };

  /** The delete inside the kernel's transaction, as kernel references. */
  const deleteInTransaction = async (
    ctx: EntityKernelContext,
    ids: ZodOutput<SchemasFor<E>["id"]>[],
  ): Promise<EntityKernelDeleteResult> => {
    if (spec.delete) {
      const outcome = await spec.delete(ctx, ids);
      return {
        deletedReferences: deletedWithImages(
          entity,
          outcome?.removed ?? ids,
          outcome?.deletedImageShortcodes ?? [],
        ),
        detachedImageKeys: outcome?.detachedImageKeys,
      };
    }
    const result = await deleteByPolicy(ctx.db, {
      entity: removable,
      policy: lifecycle.delete,
      shortcodes: ids,
      actor: ctx.actorContext,
      ...spec.deleteHooks,
    });
    await spec.afterDelete?.(ctx, result.ids);
    return {
      deletedReferences: deletedWithImages(
        entity,
        ids,
        result.deletedImageShortcodes,
      ),
      detachedImageKeys: result.detachedImageKeys,
    };
  };

  const { create, update, bulkUpdate, merge } = spec;
  const repository: EntityRepository<E, SchemasFor<E>> = {
    get: spec.get,
    list: spec.list,
    listRead: spec.listRead,
    listSummary: spec.listSummary,
  };
  // Only the actions the declaration grants reach the kernel; a readOnly
  // entity's spec may still carry methods its own workflows use.
  if (declared("create") && create)
    repository.create = async (ctx, data) =>
      written(ctx, await create(ctx, data));
  if (declared("update") && update)
    repository.update = async (ctx, id, data) =>
      written(ctx, await update(ctx, id, data));
  if (declared("bulkUpdate") && bulkUpdate) repository.bulkUpdate = bulkUpdate;
  if (declared("delete"))
    repository.delete = async (ctx, ids) => {
      // Every DB touch inside the delete goes through the transaction-bound
      // context (a pool-bound service UPDATE on a row this transaction locked
      // waits forever), and queue publications wait for the commit.
      const deferred = deferPublications();
      const { result, affectedEdges } = await executeDeleteWithEffects(
        ctx.db,
        removable,
        ids,
        lifecycle.delete,
        (transactionDb) =>
          deleteInTransaction(
            {
              ...ctx,
              db: transactionDb,
              services: {
                ...ctx.services,
                recipeCosting: ctx.services.recipeCosting.bindTo(
                  transactionDb,
                  deferred.publish,
                ),
              },
            },
            ids,
          ),
      );
      await deferred.flush(ctx.db);
      return { ...result, affectedEdges };
    };

  const mergeOperation =
    declared("merge") && merge
      ? {
          execute: async <TInput>(ctx: EntityKernelContext, input: TInput) => {
            const result = await merge.execute(ctx, merge.input.parse(input));
            const output = merge.output.parse(result.output);
            return {
              ...result,
              item: merge.item(output),
              mergeSummary: merge.summary(output),
            };
          },
        }
      : null;

  return {
    entity,
    sideEffects: spec.sideEffects ?? true,
    lifecycle,
    repository,
    mergeOperation,
    // Resolved on first use: repository modules are evaluated while the
    // generated schema bindings may still be initializing.
    get schemas(): SchemasFor<E> & EntityBindingSchemas {
      return ENTITY_SCHEMA_BINDINGS[entity];
    },
    get sort(): EntitySortContract {
      return sortFor(entity);
    },
  };
}
