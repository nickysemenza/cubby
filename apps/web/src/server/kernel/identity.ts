/**
 * Identity, merge and delete (ADR 0029 section 9). A reconciled record's id
 * comes from `RecordKey`, never from its contents. An absorbed record's id
 * and shortcode keep resolving to its survivor on reads; writes addressed to
 * it are refused and name the survivor. Web, native and MCP resolve through
 * the functions here.
 */
import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";
import {
  ENTITY_LABEL,
  ENTITY_NOT_FOUND_REASON,
  parseEntityId,
} from "@cubby/schemas/identifiers";
import { and, eq, getTableColumns, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { Database } from "~/server/db/database";
import { entityIdentity } from "~/server/db/entity-identity-schema";
import { withTransaction } from "~/server/db/helpers/core";
import { recordKey } from "~/server/db/kernel-schema";
import {
  repositoryQueries,
  type RepositoryQueryClient,
} from "~/server/db/repository-access.boundary";
import { resolveEntityIdentity } from "~/server/entity-kernel/repo/entity-identity";
import { createAppError } from "~/server/errors/app-error";
import {
  cascadeRemoval,
  type RemovableEntity,
} from "~/server/generic/removal/repo/core";

import type { ColumnRef, KeyedTable, ScopeRef } from "./define";
import { decisionKey, recordSubject, rowKey } from "./keys";
import { idColumn } from "./reads";

type Q = Pick<RepositoryQueryClient, "select" | "execute" | "update">;

export type ResolvedRecord = {
  entity: string;
  id: string;
  shortcode: string;
  /** The code the caller named, when it was absorbed into this survivor. */
  absorbed: string | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const canonical = alias(entityIdentity, "canonical");

/**
 * A public code or id for reading: an absorbed record resolves to its
 * survivor. A deleted or unknown record is null.
 */
export async function resolveForRead(
  db: Database,
  codeOrId: string,
): Promise<ResolvedRecord | null> {
  if (!UUID.test(codeOrId)) {
    const resolved = await resolveEntityIdentity(db, codeOrId);
    switch (resolved.state) {
      case "live":
        return {
          entity: resolved.kind,
          id: resolved.id,
          shortcode: resolved.shortcode,
          absorbed: null,
        };
      case "redirected":
        return resolved.canonicalDeletedAt === null
          ? {
              entity: resolved.kind,
              id: resolved.canonicalId,
              shortcode: resolved.canonicalShortcode,
              absorbed: resolved.requested,
            }
          : null;
      default:
        return null;
    }
  }
  const [row] = await repositoryQueries(db)
    .select({
      kind: entityIdentity.kind,
      shortcode: entityIdentity.shortcode,
      deletedAt: entityIdentity.deletedAt,
      canonicalId: canonical.id,
      canonicalShortcode: canonical.shortcode,
      canonicalDeletedAt: canonical.deletedAt,
    })
    .from(entityIdentity)
    .leftJoin(canonical, eq(canonical.id, entityIdentity.mergedIntoId))
    .where(eq(entityIdentity.id, codeOrId))
    .limit(1);
  if (!row) return null;
  if (row.canonicalId && row.canonicalShortcode)
    return row.canonicalDeletedAt === null
      ? {
          entity: row.kind,
          id: row.canonicalId,
          shortcode: row.canonicalShortcode,
          absorbed: row.shortcode,
        }
      : null;
  if (row.deletedAt !== null || row.shortcode === null) return null;
  return {
    entity: row.kind,
    id: codeOrId,
    shortcode: row.shortcode,
    absorbed: null,
  };
}

/** A public code or id for writing: an absorbed record is refused, naming its survivor. */
export async function resolveForWrite(
  db: Database,
  entity: ShortcodeEntity,
  codeOrId: string,
): Promise<ResolvedRecord> {
  const resolved = await resolveForRead(db, codeOrId);
  if (!resolved || resolved.entity !== entity)
    throw createAppError(
      ENTITY_NOT_FOUND_REASON[entity],
      `${ENTITY_LABEL[entity]} not found: ${codeOrId}`,
    );
  if (resolved.absorbed)
    throw createAppError(
      "RECORD_ABSORBED",
      `${resolved.absorbed} was merged into ${resolved.shortcode}; write to ${resolved.shortcode} instead.`,
    );
  return resolved;
}

/**
 * The removal port for a reconciled entity table: soft delete, then the
 * generic removal cascade (identity tombstone, search artifacts, review
 * targets). A domain with its own delete policy passes that instead.
 */
export function entityRemoval(
  entity: RemovableEntity,
  table: KeyedTable,
): NonNullable<ColumnRef["remove"]> {
  return async (tx, ids) => {
    if (!ids.length) return;
    await withTransaction(tx, async (drizzleTx) => {
      const columns = getTableColumns(table);
      if (columns.deletedAt)
        await drizzleTx
          .update(table)
          .set({ deletedAt: new Date() })
          .where(
            and(
              inArray(idColumn(table), [...ids]),
              sql`${columns.deletedAt} IS NULL`,
            ),
          );
      await cascadeRemoval(drizzleTx, {
        entity,
        ids: ids.map((id) => parseEntityId(entity, id)),
        audit: { into: [] },
      });
    });
  };
}

/** Remove records through their table's removal port, or the plain fallback. */
export async function removeRecords(
  tx: Database,
  target: ColumnRef,
  ids: readonly string[],
): Promise<void> {
  if (!ids.length) return;
  if (target.remove) return target.remove(tx, ids);
  const q = repositoryQueries(tx);
  const deletedAt = getTableColumns(target.table).deletedAt;
  if (deletedAt)
    await q
      .update(target.table)
      .set({ deletedAt: new Date() })
      .where(
        and(
          inArray(idColumn(target.table), [...ids]),
          sql`${deletedAt} IS NULL`,
        ),
      );
  else
    await q
      .delete(target.table)
      .where(inArray(idColumn(target.table), [...ids]));
}

export type MergeVerdict =
  | {
      merged: true;
      keepId: string;
      loserId: string;
      keys: string[];
      scopes: ScopeRef[];
    }
  | { merged: false; reason: "decided" | "not-minted" | "unknown-record" };

/**
 * Merge two records of one table inside the apply transaction. `decision`
 * merges a member's `same`. `proof` merges without asking only in ADR 0029's
 * one case: a unique complete payment match, and the absorbed record was
 * created by Cubby and carries no decision; any other case returns the reason
 * and the caller leaves an identity gap. The older record survives; the
 * absorbed record's `RecordKey` rows repoint to it.
 */
export async function mergeRecords(
  tx: Database,
  merge: {
    target: ColumnRef;
    a: string;
    b: string;
    basis: "proof" | "decision";
  },
): Promise<MergeVerdict> {
  const { target } = merge;
  if (!target.merge) throw new Error(`${target.name} declares no merge policy`);
  const q = repositoryQueries(tx);
  const entity = target.entity ?? target.name;
  const createdAt = getTableColumns(target.table).createdAt;
  const rows = await q
    .select({
      id: sql<string>`${idColumn(target.table)}::text`,
      created: createdAt
        ? sql<string>`to_char(${createdAt}, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`
        : sql<string>`''`,
    })
    .from(target.table)
    .where(inArray(idColumn(target.table), [merge.a, merge.b]));
  if (rows.length !== 2) return { merged: false, reason: "unknown-record" };
  const [first, second] = [...rows].sort((x, y) =>
    x.created === y.created
      ? x.id < y.id
        ? -1
        : 1
      : x.created < y.created
        ? -1
        : 1,
  );
  const keepId = first!.id;
  const loserId = second!.id;
  if (merge.basis === "proof") {
    const [minted] = await q
      .select({ minted: sql<boolean>`bool_or(${recordKey.minted})` })
      .from(recordKey)
      .where(
        and(eq(recordKey.entity, entity), eq(recordKey.entityId, loserId)),
      );
    if (!minted?.minted) return { merged: false, reason: "not-minted" };
    const decided = await q.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM "Decision"
      WHERE subject = ${recordSubject(entity, loserId)} OR other = ${recordSubject(entity, loserId)}`);
    if ((decided.rows[0]?.n ?? 0) > 0)
      return { merged: false, reason: "decided" };
  }
  await target.merge(tx, { keepId, loserIds: [loserId] });
  const moved = await q
    .update(recordKey)
    .set({ entityId: keepId })
    .where(and(eq(recordKey.entity, entity), eq(recordKey.entityId, loserId)))
    .returning({
      scopeKind: recordKey.scopeKind,
      scopeKey: recordKey.scopeKey,
    });
  const owners = await q
    .select({ scopeKind: recordKey.scopeKind, scopeKey: recordKey.scopeKey })
    .from(recordKey)
    .where(and(eq(recordKey.entity, entity), eq(recordKey.entityId, keepId)));
  const scopes = new Map<string, ScopeRef>();
  for (const row of [...moved, ...owners])
    scopes.set(`${row.scopeKind}:${row.scopeKey}`, {
      kind: row.scopeKind,
      key: row.scopeKey,
    });
  return {
    merged: true,
    keepId,
    loserId,
    keys: [
      rowKey(target.name, keepId),
      rowKey(target.name, loserId),
      decisionKey(recordSubject(entity, keepId)),
      decisionKey(recordSubject(entity, loserId)),
    ],
    scopes: [...scopes.values()],
  };
}

/** Mark a record's keys rejected so its evidence does not create it again. */
export async function markRejected(
  q: Q,
  entity: string,
  entityId: string,
): Promise<ScopeRef[]> {
  const rows = await q
    .update(recordKey)
    .set({ rejectedAt: new Date() })
    .where(
      and(
        eq(recordKey.entity, entity),
        eq(recordKey.entityId, entityId),
        sql`${recordKey.rejectedAt} IS NULL`,
      ),
    )
    .returning({
      scopeKind: recordKey.scopeKind,
      scopeKey: recordKey.scopeKey,
    });
  return rows.map((row) => ({ kind: row.scopeKind, key: row.scopeKey }));
}

/** Clear a rejection: the record may be created again from its evidence. */
export async function clearRejected(
  q: Q,
  entity: string,
  entityId: string,
): Promise<ScopeRef[]> {
  const rows = await q
    .update(recordKey)
    .set({ rejectedAt: null })
    .where(and(eq(recordKey.entity, entity), eq(recordKey.entityId, entityId)))
    .returning({
      scopeKind: recordKey.scopeKind,
      scopeKey: recordKey.scopeKey,
    });
  return rows.map((row) => ({ kind: row.scopeKind, key: row.scopeKey }));
}
