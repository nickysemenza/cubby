/**
 * Shared merge mechanics. Finalization keeps row removal and embedding/audit
 * cascade in one transaction; removal order remains caller-controlled because
 * partial unique indexes make it load-bearing.
 */

import type { ActorContext } from "@cubby/schemas/context";
import type { Entity } from "@cubby/schemas/entity";
import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";
import type { EntityId } from "@cubby/schemas/identifiers";
import { type AnyColumn, and, getTableColumns, inArray } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { uniq } from "es-toolkit";
import type { Database, DrizzleTransaction } from "~/server/db";
import type {
  IncomingEdge,
  IncomingEdgeKey,
} from "~/server/db/entity-incoming-edges";
import { INCOMING_EDGES } from "~/server/db/entity-incoming-edges";
import { createAppError } from "~/server/errors/app-error";
import type { AuditEntryInput } from "~/server/repo/audit-log";
import { logAuditEntries } from "~/server/repo/audit-log";
import { notDeleted } from "~/server/repo/database-helpers";
import type { RemovableEntity } from "~/server/repo/removal";
import { cascadeRemoval } from "~/server/repo/removal";
import { resolveAllOrThrow } from "~/server/repo/shortcode-resolver";

type MergeableTable = PgTable & { id: AnyColumn; deletedAt: AnyColumn };

type MergeAuditChanges = Record<string, { from: unknown; to: unknown }>;

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
    codes.map((code, i) => [code, ids[i]!]),
  );
  const keepId = byCode.get(args.keepId)!;
  const loserIds = uniq(args.mergeIds.map((code) => byCode.get(code)!));
  return { keepId, loserIds };
};

/** Derive the column from the declared edge key so callers cannot miswire it. */
const edgeColumn = <E extends Entity>(
  entity: E,
  edgeKey: IncomingEdgeKey<E>,
): PgColumn => {
  const edges = INCOMING_EDGES[entity] as unknown as Record<
    string,
    IncomingEdge | undefined
  >;
  const edge = edges[edgeKey as string];
  if (!edge) {
    throw new Error(`No incoming edge ${String(edgeKey)} on ${entity}`);
  }
  return edge.column as PgColumn;
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
  // biome-ignore lint/suspicious/noExplicitAny: Drizzle's column->table back-reference is untyped.
  const table = (column as any).table as MergeableTable;
  const columns = getTableColumns(table);
  const property = Object.keys(columns).find(
    (key) => columns[key as keyof typeof columns] === column,
  );
  if (!property) {
    throw new Error(
      `Could not resolve a column property for ${String(edgeKey)}`,
    );
  }

  const conditions = [inArray(column, [...args.from])];
  if (args.liveOnly) conditions.push(notDeleted(table));

  const rows = await tx
    .update(table)
    // biome-ignore lint/suspicious/noExplicitAny: dynamic single-column set, keyed by the edge's own property.
    .set({ [property]: args.to } as any)
    .where(and(...conditions))
    // biome-ignore lint/suspicious/noExplicitAny: AnyColumn is too narrow for returning().
    .returning({ id: table.id as any });
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
          // biome-ignore lint/suspicious/noExplicitAny: AnyColumn is too narrow for returning().
          .returning({ id: table.id as any })
      : await tx
          .update(table)
          // biome-ignore lint/suspicious/noExplicitAny: dynamic soft-delete over a structurally-typed table.
          .set({ deletedAt: new Date() } as any)
          .where(and(inArray(table.id, ids), notDeleted(table)))
          // biome-ignore lint/suspicious/noExplicitAny: AnyColumn is too narrow for returning().
          .returning({ id: table.id as any });

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
