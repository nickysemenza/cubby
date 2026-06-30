/**
 * Generic repo CRUD factory.
 *
 * Collapses the per-entity getByID/update boilerplate — 404 on a missing live
 * row, before-state → `computeChanges` → audit, re-fetch → map — into one
 * orchestrator, driven by the shared `entityManifest` for the cross-cutting
 * traits (auditable / soft-delete). Each entity supplies only what's genuinely
 * its own: the table, a typed relations-loaded `fetchById`, its DB→API mapper,
 * and the update→column mapping. The flat `(db, …, actor)` repo surface is
 * preserved, so routers and services are untouched.
 *
 * `fetchById` is a caller-provided function (rather than a generic query the
 * factory builds) precisely so Drizzle's relational-query typing stays intact —
 * no `as`-casting the opaque query object.
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

interface EntityCrudConfig<
  TTable extends CrudTable,
  TRow extends Record<string, unknown>,
  TOut,
  TUpdate,
  TId extends string,
> {
  table: TTable;
  /** Manifest key — drives the auditable / soft-delete behavior. */
  entity: AuditableEntity;
  /** Relations-loaded fetch of a live row by id; `undefined` when absent. */
  fetchById: (db: Database, id: TId) => Promise<TRow | undefined>;
  /** DB row → API shape. Async to support mappers that do a follow-up query. */
  fromDB: (db: Database, row: TRow) => TOut | Promise<TOut>;
  /** Update payload → column values handed to the UPDATE. */
  toUpdate: (data: TUpdate) => Partial<InferInsertModel<TTable>>;
  /** Columns whose change is recorded in the audit diff. */
  auditUpdateFields: readonly string[];
  /** AppError reason thrown when getByID finds no live row. */
  notFoundReason: AppErrorReason;
}

export interface EntityCrud<TOut, TUpdate, TId extends string> {
  getByID: (db: Database, id: TId) => Promise<TOut>;
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

  const getByID = async (db: Database, id: TId): Promise<TOut> => {
    const row = await config.fetchById(db, id);
    if (!row) {
      throw createAppError(
        config.notFoundReason,
        `${manifest.name} ${id} not found`,
      );
    }
    return config.fromDB(db, row);
  };

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

    const row = await config.fetchById(db, id);
    if (!row) {
      // Just written, so absence is a genuine 500, not a 404.
      throw new Error(`Failed to fetch updated ${manifest.name}`);
    }
    return config.fromDB(db, row);
  };

  return { getByID, update };
}
