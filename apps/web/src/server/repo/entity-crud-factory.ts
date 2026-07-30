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
 *   the shared `entityManifest` for the auditable trait. It runs in ONE
 *   transaction, and joins the caller's when there already is one — see
 *   `updateTx`.
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
import type { AnyColumn } from "drizzle-orm";
import type { PgTable, PgUpdateSetSource } from "drizzle-orm/pg-core";
import type { Database, DrizzleTransaction } from "~/server/db";
import { createAppError } from "~/server/errors/app-error";
import { computeChanges, logAuditEntry } from "~/server/repo/audit-log";
import {
  updateLiveAndReturn,
  withTransactionOn,
} from "~/server/repo/database-helpers";

/** A soft-deletable table the factory can update by id. */
type CrudTable = PgTable & { id: AnyColumn; deletedAt: AnyColumn };

/**
 * Which handle the reader's callbacks accept.
 *
 * Defaults to `Database` so the five reader-only entities (project, task,
 * product, meal, inventory) are unaffected. Widening the default to
 * `Database | DrizzleTransaction` would NOT be a free generalization:
 * `project`'s and `task`'s `fromDB` fan out to loaders typed `(db: Database,
 * …)`, and under `strictFunctionTypes` those parameters are checked
 * contravariantly — so the union would have to be threaded transitively through
 * four subtree/dependency loaders that have no need for it. Only
 * `EntityCrudConfig` (expense, ingredient), whose `update` is now transactional,
 * instantiates the union.
 */
type ReaderDb = Database | DrizzleTransaction;

interface EntityReaderConfig<TRow, TOut, TId extends string, TDb = Database> {
  /** Used only in the 404 message. */
  entityName: string;
  /** Relations-loaded fetch of a live row by id; `undefined` when absent. */
  fetchById: (db: TDb, id: TId) => Promise<TRow | undefined>;
  /** DB row → API shape. Async to support mappers that do a follow-up query. */
  fromDB: (db: TDb, row: TRow) => TOut | Promise<TOut>;
  /** AppError reason thrown when `getByID` finds no live row. */
  notFoundReason: AppErrorReason;
}

export interface EntityReader<TOut, TId extends string, TDb = Database> {
  /** Fetch by id, throwing `notFoundReason` when there is no live row. */
  getByID: (db: TDb, id: TId) => Promise<TOut>;
  /** Fetch by id, returning `null` when there is no live row. */
  getByIDOrNull: (db: TDb, id: TId) => Promise<TOut | null>;
}

export function createEntityReader<
  TRow,
  TOut,
  TId extends string,
  TDb = Database,
>(
  config: EntityReaderConfig<TRow, TOut, TId, TDb>,
): EntityReader<TOut, TId, TDb> {
  const getByIDOrNull = async (db: TDb, id: TId): Promise<TOut | null> => {
    const row = await config.fetchById(db, id);
    return row ? config.fromDB(db, row) : null;
  };

  const getByID = async (db: TDb, id: TId): Promise<TOut> => {
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
> extends Omit<EntityReaderConfig<TRow, TOut, TId, ReaderDb>, "entityName"> {
  table: TTable;
  /** Manifest key — drives the auditable / soft-delete behavior. */
  entity: AuditableEntity;
  /** Update payload → column values handed to the UPDATE. */
  toUpdate: (data: TUpdate) => PgUpdateSetSource<TTable>;
  /** Columns whose change is recorded in the audit diff. */
  auditUpdateFields: readonly string[];
}

export interface EntityCrud<TOut, TUpdate, TId extends string>
  extends EntityReader<TOut, TId, ReaderDb> {
  /**
   * Diff-audited column update, atomic end to end. Accepts an already-open
   * transaction so a caller that resolves related rows first (see
   * `updateExpense`) can put that resolve and this write in ONE boundary.
   */
  update: (
    db: ReaderDb,
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
  const reader = createEntityReader<TRow, TOut, TId, ReaderDb>({
    entityName: config.entity,
    fetchById: config.fetchById,
    fromDB: config.fromDB,
    notFoundReason: config.notFoundReason,
  });

  /**
   * The audited write itself, on an OPEN transaction: before-state → UPDATE →
   * audit entry → re-read. Every step is on `tx`, which is the point — the
   * before-state, the UPDATE and the audit row either all land or none do, so a
   * throw here (`updateLiveAndReturn` throws when the row was concurrently
   * soft-deleted) can't leave a half-applied edit or an audit row describing a
   * write that never happened. It also lets a caller fold its own pre-work into
   * the same boundary (`updateExpense`'s charge resolution).
   *
   * Atomic is NOT serialized. Nothing here takes a row lock — `fetchById` is a
   * plain read — so two concurrent updates to the same row still both diff
   * against the same before-state and write two audit entries claiming the same
   * `from`. Last write wins on the columns; the audit trail reads as if the
   * loser's change never had an intermediate state. Closing that needs a
   * `SELECT … FOR UPDATE` on the live row (cf. `lockAndValidateForDelete`),
   * which is deliberately not done: it costs a round trip on every update of
   * every entity to fix a trail-cosmetics problem on a single-user tool, and it
   * would introduce a second lock-ordering to reason about against the delete
   * path.
   */
  const updateTx = async (
    tx: DrizzleTransaction,
    id: TId,
    data: TUpdate,
    actor: ActorContext,
  ): Promise<TOut> => {
    // Capture before-state for the audit diff (before the UPDATE lands).
    const before = await config.fetchById(tx, id);

    const updated = await updateLiveAndReturn(
      tx,
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
        await logAuditEntry(tx, actor, {
          entityType: config.entity,
          entityId: id,
          action: "update",
          changes,
        });
      }
    }

    // Just written, so a missing row is a genuine 500, not a 404.
    //
    // Read on `tx`, never on the outer handle: the row's new state is
    // uncommitted, so a read on `db` — a DIFFERENT connection out of the
    // per-request `pg.Pool` (max 5) — could not see it, and would contend for a
    // connection with the transaction that is still holding one.
    return reader.getByID(tx, id);
  };

  const update = (
    db: ReaderDb,
    id: TId,
    data: TUpdate,
    actor: ActorContext,
  ): Promise<TOut> =>
    withTransactionOn(db, (tx) => updateTx(tx, id, data, actor));

  return { ...reader, update };
}
