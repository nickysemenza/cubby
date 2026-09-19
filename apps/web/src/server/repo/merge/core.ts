/**
 * Shared merge mechanics. Finalization keeps row removal and embedding/audit
 * cascade in one transaction; removal order remains caller-controlled because
 * partial unique indexes make it load-bearing.
 */

import type { ActorContext } from "@cubby/schemas/context";
import type { Entity } from "@cubby/schemas/entity";
import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";
import type { EntityId } from "@cubby/schemas/identifiers";
import { type AnyColumn, and, eq, getTableColumns, inArray } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { uniq } from "es-toolkit";

import type { Database, DrizzleTransaction } from "~/server/db";
import type { IncomingEdgeKey } from "~/server/db/entity-incoming-edges";
import { INCOMING_EDGES } from "~/server/db/entity-incoming-edges";
import { importFinding } from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import type { AuditEntryInput } from "~/server/repo/audit-log";
import { logAuditEntries } from "~/server/repo/audit-log";
import { notDeleted } from "~/server/repo/database-helpers";
import type { RemovableEntity } from "~/server/repo/removal";
import { cascadeRemoval } from "~/server/repo/removal";
import { resolveAllOrThrow } from "~/server/repo/shortcode-resolver";

type MergeableTable = PgTable & { id: PgColumn; deletedAt: PgColumn };

type MergeAuditChanges = Record<string, { from: unknown; to: unknown }>;

const requireResolvedId = <E extends ShortcodeEntity>(
  id: EntityId<E> | undefined,
  code: string,
): EntityId<E> => {
  if (id === undefined) {
    throw new Error(`Resolved merge target disappeared for ${code}`);
  }
  return id;
};

/** Refuse self-merge instead of silently filtering the keeper from losers. */
export const assertDistinctMergeTargets = (
  entity: Entity,
  keepId: string,
  mergeIds: readonly string[],
): void => {
  if (!mergeIds.includes(keepId)) return;
  throw createAppError(
    "MERGE_SELF_REFERENCE",
    `Cannot merge a ${entity} into itself: keepId is also named in mergeIds.`,
  );
};

/** Resolve live targets, rejecting self-reference and every missing code. */
export const resolveMergeTargets = async <E extends ShortcodeEntity>(
  db: Database,
  args: {
    entity: E;
    keepId: string;
    mergeIds: readonly string[];
  },
): Promise<{ keepId: EntityId<E>; loserIds: EntityId<E>[] }> => {
  assertDistinctMergeTargets(args.entity, args.keepId, args.mergeIds);
  const codes = uniq([args.keepId, ...args.mergeIds]);
  const ids = await resolveAllOrThrow(db, args.entity, codes);
  const byCode = new Map<string, EntityId<E>>(
    codes.map((code, i) => {
      const pair: [string, EntityId<E>] = [
        code,
        requireResolvedId(ids[i], code),
      ];
      return pair;
    }),
  );
  const keepId = requireResolvedId(byCode.get(args.keepId), args.keepId);
  const loserIds = uniq(
    args.mergeIds.map((code) => requireResolvedId(byCode.get(code), code)),
  );
  return { keepId, loserIds };
};

/** Derive the column from the declared edge key so callers cannot miswire it. */
const edgeColumn = <E extends Entity>(
  entity: E,
  edgeKey: IncomingEdgeKey<E>,
): AnyColumn => {
  const edge = Object.entries(INCOMING_EDGES[entity]).find(
    ([key]) => key === edgeKey,
  )?.[1];
  if (!edge) {
    throw new Error(`No incoming edge ${String(edgeKey)} on ${entity}`);
  }
  return edge.column;
};

/**
 * `liveOnly` is explicit: hard deletes must repoint tombstones too, while
 * collision-folding merges must not revive rows soft-deleted to vacate a slot.
 */
export const repointEdge = async <E extends Entity>(
  tx: DrizzleTransaction,
  entity: E,
  edgeKey: IncomingEdgeKey<E>,
  args: { from: readonly string[]; to: string; liveOnly: boolean },
): Promise<string[]> => {
  if (args.from.length === 0) return [];
  const column = edgeColumn(entity, edgeKey);
  // SAFETY: Every incoming-edge column is declared on a PostgreSQL table with
  // the `id` and `deletedAt` columns required by merge operations.
  const table = column.table as MergeableTable;
  const columns = getTableColumns(table);
  const property = Object.entries(columns).find(
    ([, candidate]) => candidate === column,
  )?.[0];
  if (!property) {
    throw new Error(
      `Could not resolve a column property for ${String(edgeKey)}`,
    );
  }

  const conditions = [inArray(column, [...args.from])];
  if (args.liveOnly) conditions.push(notDeleted(table));

  const rows = await tx
    .update(table)
    .set({ [property]: args.to })
    .where(and(...conditions))
    .returning({ id: table.id });
  return rows.map((row) => String(row.id));
};

/**
 * Removes losers and cascades embeddings/audit atomically. `removed` comes from
 * `returning()`, not requested IDs, because callers may pre-delete collisions.
 */
export const finalizeMerge = async <E extends RemovableEntity>(
  tx: DrizzleTransaction,
  args: {
    entity: E;
    table: MergeableTable;
    keepId: EntityId<E>;
    loserIds: readonly EntityId<E>[];
    /** `hard` is `mergeIngredients` only; every other merge soft-deletes. */
    removal: "soft" | "hard";
    /** Omit for a merge with no actor context (`mergeIngredients`). */
    actor?: ActorContext;
    /** Recorded on the survivor's `update` entry. No entry is written when empty. */
    survivorChanges?: MergeAuditChanges;
  },
): Promise<{ removed: number }> => {
  const { entity, table, keepId, loserIds, removal, actor } = args;
  if (loserIds.length === 0) return { removed: 0 };
  const ids = [...loserIds];

  if (entity === "purchase" || entity === "expense" || entity === "product") {
    const findings = await tx
      .select({
        id: importFinding.id,
        ledgerPartyId: importFinding.ledgerPartyId,
        kind: importFinding.kind,
        evidenceFingerprint: importFinding.evidenceFingerprint,
        status: importFinding.status,
      })
      .from(importFinding)
      .where(
        and(
          eq(importFinding.targetType, entity),
          inArray(importFinding.targetId, ids),
        ),
      );
    for (const finding of findings) {
      const [collision] =
        finding.status === "open"
          ? await tx
              .select({ id: importFinding.id })
              .from(importFinding)
              .where(
                and(
                  eq(importFinding.ledgerPartyId, finding.ledgerPartyId),
                  eq(importFinding.targetType, entity),
                  eq(importFinding.targetId, keepId),
                  eq(importFinding.kind, finding.kind),
                  eq(
                    importFinding.evidenceFingerprint,
                    finding.evidenceFingerprint,
                  ),
                  eq(importFinding.status, "open"),
                ),
              )
              .limit(1)
          : [];
      if (collision) {
        await tx.delete(importFinding).where(eq(importFinding.id, finding.id));
      } else {
        await tx
          .update(importFinding)
          .set({ targetId: keepId, updatedAt: new Date() })
          .where(eq(importFinding.id, finding.id));
      }
    }
  }

  // The row removal stays here rather than moving into `cascadeRemoval`:
  // removal differs per entity (soft for products/purchases/vendors, hard for
  // ingredients) and its position relative to a caller's own writes can be
  // load-bearing when a partial unique index is involved. Only the tail —
  // cascade plus delete entries — is shared.
  const removedRows =
    removal === "hard"
      ? await tx
          .delete(table)
          .where(inArray(table.id, ids))
          .returning({ id: table.id })
      : await tx
          .update(table)
          .set({ deletedAt: new Date() })
          .where(and(inArray(table.id, ids), notDeleted(table)))
          .returning({ id: table.id });

  // A merge with no actor context (`mergeIngredients`) still has to cascade, so
  // the entries go to a local buffer that is only flushed when there IS one.
  // That is the one difference from every other removal path — and the reason
  // `cascadeRemoval`'s audit sink is mandatory rather than optional.
  const entries: AuditEntryInput[] = [];
  const survivorChanges = args.survivorChanges ?? {};
  if (actor && Object.keys(survivorChanges).length > 0) {
    entries.push({
      entityType: entity,
      entityId: keepId,
      action: "update",
      changes: survivorChanges,
    });
  }
  await cascadeRemoval(tx, { entity, ids, audit: { into: entries } });
  if (actor) await logAuditEntries(tx, actor, entries);
  return { removed: removedRows.length };
};
