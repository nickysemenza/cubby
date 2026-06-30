/**
 * Generic repo CRUD factory.
 *
 * Two layers, because the entities share a lot on the READ path but diverge on
 * writes:
 *
 * - `createEntityReader` collapses the identical "fetch a live row by id (with
 *   relations) → 404-or-null → map to API" shape that every entity repeats. Both
 *   the throwing (`getByID`) and nullable (`getByIDOrNull`) variants come from
 *   one place.
 * - `createEntityCrud` adds the simple diff-audited `update` orchestration
 *   (before-state → `computeChanges` → audit entry → re-fetch → map), driven by
 *   the shared `entityManifest` for the auditable trait.
 *
 * Write paths with genuinely entity-specific logic — transactional child
 * management (meal), valuation recompute (inventory), parent-cycle guards +
 * recursive reads (location), shortcode/image/unit-mapping side-effects
 * (product) — stay hand-rolled in their repos. Forcing them through hooks would
 * relocate that logic into callbacks, not remove it.
 *
 * `fetchById` is a caller-provided typed function (rather than a query the
 * factory builds generically), so Drizzle's relational typing stays intact — no
 * `as`-casting the opaque query object. The factory is parameterized over the
 * branded id (`TId`) so branding threads end-to-end.
 */
import type { ActorContext } from "@cubby/schemas/context";
import {
  type AuditableEntity,
  entityManifest,
} from "@cubby/schemas/entity-manifest";
import type { AppErrorReason } from "@cubby/shared";
import type { AnyColumn, InferInsertModel } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import type { Database } from "~/server/db";
import { createAppError } from "~/server/errors/app-error";
import { computeChanges, logAuditEntry } from "~/server/repo/audit-log";
import { updateLiveAndReturn } from "~/server/repo/database-helpers";

/** A soft-deletable table the factory can update by id. */
type CrudTable = PgTable & { id: AnyColumn; deletedAt: AnyColumn };

interface EntityReaderConfig<TRow, TOut, TId extends string> {
  /** Used only in the 404 message. */
  entityName: string;
  /** Relations-loaded fetch of a live row by id; `undefined` when absent. */
  fetchById: (db: Database, id: TId) => Promise<TRow | undefined>;
  /** DB row → API shape. Async to support mappers that do a follow-up query. */
  fromDB: (db: Database, row: TRow) => TOut | Promise<TOut>;
  /** AppError reason thrown when `getByID` finds no live row. */
  notFoundReason: AppErrorReason;
}

export interface EntityReader<TOut, TId extends string> {
  /** Fetch by id, throwing `notFoundReason` when there is no live row. */
  getByID: (db: Database, id: TId) => Promise<TOut>;
  /** Fetch by id, returning `null` when there is no live row. */
  getByIDOrNull: (db: Database, id: TId) => Promise<TOut | null>;
}

export function createEntityReader<TRow, TOut, TId extends string>(
  config: EntityReaderConfig<TRow, TOut, TId>,
): EntityReader<TOut, TId> {
  const getByIDOrNull = async (db: Database, id: TId): Promise<TOut | null> => {
    const row = await config.fetchById(db, id);
    return row ? config.fromDB(db, row) : null;
  };

  const getByID = async (db: Database, id: TId): Promise<TOut> => {
    const result = await getByIDOrNull(db, id);
    if (result === null) {
      throw createAppError(
        config.notFoundReason,
        `${config.entityName} ${id} not found`,
      );
    }
    return result;
  };

  return { getByID, getByIDOrNull };
}

interface EntityCrudConfig<
  TTable extends CrudTable,
  TRow extends Record<string, unknown>,
  TOut,
  TUpdate,
  TId extends string,
> extends Omit<EntityReaderConfig<TRow, TOut, TId>, "entityName"> {
  table: TTable;
  /** Manifest key — drives the auditable / soft-delete behavior. */
  entity: AuditableEntity;
  /** Update payload → column values handed to the UPDATE. */
  toUpdate: (data: TUpdate) => Partial<InferInsertModel<TTable>>;
  /** Columns whose change is recorded in the audit diff. */
  auditUpdateFields: readonly string[];
}

export interface EntityCrud<TOut, TUpdate, TId extends string>
  extends EntityReader<TOut, TId> {
  update: (
    db: Database,
    id: TId,
    data: TUpdate,
    actor: ActorContext,
  ) => Promise<TOut>;
}

export function createEntityCrud<
  TTable extends CrudTable,
  TRow extends Record<string, unknown>,
  TOut,
  TUpdate,
  TId extends string,
>(
  config: EntityCrudConfig<TTable, TRow, TOut, TUpdate, TId>,
): EntityCrud<TOut, TUpdate, TId> {
  const manifest = entityManifest[config.entity];
  const reader = createEntityReader({
    entityName: manifest.name,
    fetchById: config.fetchById,
    fromDB: config.fromDB,
    notFoundReason: config.notFoundReason,
  });

  const update = async (
    db: Database,
    id: TId,
    data: TUpdate,
    actor: ActorContext,
  ): Promise<TOut> => {
    // Capture before-state for the audit diff (before the UPDATE lands).
    const before = await config.fetchById(db, id);

    const updated = await updateLiveAndReturn(
      db,
      config.table,
      config.toUpdate(data),
      id,
    );

    if (manifest.auditable && before) {
      const changes = computeChanges(
        before,
        updated as Record<string, unknown>,
        [...config.auditUpdateFields],
      );
      if (changes) {
        await logAuditEntry(db, actor, {
          entityType: manifest.name,
          entityId: id,
          action: "update",
          changes,
        });
      }
    }

    // Just written, so a missing row is a genuine 500, not a 404.
    return reader.getByID(db, id);
  };

  return { ...reader, update };
}
