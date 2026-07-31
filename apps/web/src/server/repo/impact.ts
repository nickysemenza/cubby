import type {
  ImpactItem,
  OperationDisposition,
  OperationEffect,
} from "@cubby/schemas/entity-integrity";
import { type AnyColumn, and, count, inArray, type SQL } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import type { DrizzleClient, DrizzleTransaction } from "~/server/db";
import { notDeleted } from "./database-helpers";

/**
 * Shared building blocks for operation impact previews.
 *
 * A preview answers "what will this delete/merge actually do?" using the SAME
 * predicates the mutation uses, so the two cannot disagree. It is advisory
 * only: the mutation stays authoritative and rechecks everything inside its
 * transaction. A preview is not a lock, an authorization token, or a required
 * receipt — nothing may skip a check because a preview said it was fine.
 *
 * Deliberately NOT a generic cascade engine. Each repo writes its own planner
 * next to its own mutation, because the interesting part of an impact is
 * domain-specific (which edges block, which cascade, what recompute fires) and
 * a generic walker would have to re-derive that from scratch and get it subtly
 * wrong. These helpers only remove the repetitive counting.
 */

type Db = DrizzleClient | DrizzleTransaction;

/**
 * Count rows per target id for one incoming edge.
 *
 * `notDeleted` is applied unless the caller opts out — a soft-deleted row still
 * exists, and counting it would report cascade work that will not happen. The
 * two hard-delete-only source tables (`ProjectDependency`, `TaskDependency`)
 * are the only legitimate reason to pass `includeDeleted`.
 */
export async function countByTarget(
  db: Db,
  table: PgTable,
  column: PgColumn,
  ids: readonly string[],
  opts: { includeDeleted?: boolean; extraWhere?: SQL } = {},
): Promise<Record<string, number>> {
  if (ids.length === 0) return {};
  const conditions: (SQL | undefined)[] = [inArray(column, [...ids])];
  if (!opts.includeDeleted) {
    // Guarded rather than assumed: `ProjectDependency`/`TaskDependency` are
    // hard-delete-only and have no column to filter on.
    const deletedAt = (
      table as unknown as Record<string, AnyColumn | undefined>
    ).deletedAt;
    if (!deletedAt) {
      throw new Error(
        `countByTarget: ${String(column.name)}'s table has no deletedAt — pass includeDeleted for a hard-delete-only table.`,
      );
    }
    conditions.push(notDeleted({ deletedAt }));
  }
  if (opts.extraWhere) conditions.push(opts.extraWhere);

  const rows = await db
    .select({ key: column, n: count() })
    .from(table)
    .where(and(...conditions))
    .groupBy(column);

  const out: Record<string, number> = {};
  for (const row of rows) {
    if (row.key != null) out[String(row.key)] = Number(row.n);
  }
  return out;
}

/** Build an {@link ImpactItem} from a per-target count map, or null if empty. */
export function impact(args: {
  disposition: Pick<OperationDisposition, "code" | "description"> & {
    effect: OperationEffect;
  };
  edgeKey?: string;
  label: string;
  byTargetId: Record<string, number>;
}): ImpactItem | null {
  const total = Object.values(args.byTargetId).reduce((a, b) => a + b, 0);
  if (total === 0) return null;
  return {
    code: args.disposition.code,
    effect: args.disposition.effect,
    ...(args.edgeKey ? { edgeKey: args.edgeKey } : {}),
    label: args.label,
    description: args.disposition.description,
    total,
    byTargetId: args.byTargetId,
  };
}

/**
 * A consequence that isn't a row count at all — a recompute, a cache
 * invalidation, a queued embedding sweep. These are why `sideEffects` exists
 * separately from `changes`: they are real and worth surfacing, but there is
 * nothing to count per target.
 */
export function sideEffect(args: {
  code: string;
  label: string;
  description: string;
  effect?: OperationEffect;
  total?: number;
  byTargetId?: Record<string, number>;
}): ImpactItem {
  return {
    code: args.code,
    effect: args.effect ?? "preserve",
    label: args.label,
    description: args.description,
    total: args.total ?? 0,
    byTargetId: args.byTargetId ?? {},
  };
}

/** Drop the nulls `impact()` returns for empty counts. */
export const present = (items: (ImpactItem | null)[]): ImpactItem[] =>
  items.filter((i): i is ImpactItem => i !== null);
