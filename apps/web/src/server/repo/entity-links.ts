/**
 * The one write/read seam for `EntityLink` (ADR 0007). Every many-to-many
 * relationship between entities is a row here, typed by its link kind in
 * `@cubby/schemas/entity-links`; the per-domain repositories (kit
 * components, purchase products, project tools, wish candidates, garden
 * plantings, dependencies) keep their own validation and refusals and call
 * these helpers for the rows themselves.
 *
 * Every predicate names its link kind: `toEntityId` alone matches a
 * product's purchase, tool, wish, and component links at once.
 */

import {
  ENTITY_LINK_KINDS,
  type EntityLinkEnd,
  type EntityLinkKind,
  entityLinkKinds,
} from "@cubby/schemas/entity-links";
import { and, eq, inArray, isNull, type SQL, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { groupBy, sumBy, uniq } from "es-toolkit";

import type { DrizzleTransaction } from "~/server/db";
import { entityLink } from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import { unwrapDb } from "~/server/repo/database-helpers/core";
import { findDirectedDependencyCycles } from "~/server/repo/database-helpers/dependency-graph";

/** `entityLink` or an alias of it. */
type LinkTable = {
  kind: AnyPgColumn;
  deletedAt: AnyPgColumn;
  fromEntityId: AnyPgColumn;
  toEntityId: AnyPgColumn;
};

/** Rows of one link kind, live or not. */
export const ofLinkKind = (
  kind: EntityLinkKind,
  table: LinkTable = entityLink,
): SQL => eq(table.kind, kind);

/** Live rows of one link kind. `table` may be an alias of `entityLink`. */
export const liveLinks = (
  kind: EntityLinkKind,
  table: LinkTable = entityLink,
): SQL => sql`(${eq(table.kind, kind)} AND ${isNull(table.deletedAt)})`;

/** The insert row for one link, endpoint kinds filled from the declaration. */
export const linkValues = (
  kind: EntityLinkKind,
  fromEntityId: string,
  toEntityId: string,
  quantity?: number | null,
): typeof entityLink.$inferInsert => {
  const declaration = ENTITY_LINK_KINDS[kind];
  return {
    kind,
    fromEntityId,
    fromKind: declaration.from,
    toEntityId,
    toKind: declaration.to,
    quantity: declaration.quantity ? (quantity ?? 1) : null,
  };
};

/**
 * A counted link's quantity. `EntityLink_quantity_check` makes it non-null
 * exactly on kinds that declare `quantity`, so null here is a corrupt row.
 */
export const linkQuantity = (quantity: number | null): number => {
  if (quantity === null)
    throw new Error("A counted EntityLink row has no quantity.");
  return quantity;
};

const endColumn = (end: EntityLinkEnd, table: LinkTable = entityLink) =>
  end === "from" ? table.fromEntityId : table.toEntityId;

/**
 * Insert links, skipping pairs already live (the live pair key). Returns the
 * ids of the rows actually inserted.
 */
export async function attachLinks(
  tx: DrizzleTransaction,
  kind: EntityLinkKind,
  links: readonly { from: string; to: string; quantity?: number | null }[],
): Promise<string[]> {
  if (links.length === 0) return [];
  const rows = await tx
    .insert(entityLink)
    .values(
      links.map((link) => linkValues(kind, link.from, link.to, link.quantity)),
    )
    .onConflictDoNothing()
    .returning({ id: entityLink.id });
  return rows.map((row) => row.id);
}

/** Soft-delete live links of `kind` matching `where`. Returns their ids. */
async function softDeleteLinks(
  tx: DrizzleTransaction,
  kind: EntityLinkKind,
  where: SQL | undefined,
  now: Date = new Date(),
): Promise<{ id: string; fromEntityId: string; toEntityId: string }[]> {
  return await tx
    .update(entityLink)
    .set({ deletedAt: now })
    .where(and(liveLinks(kind), where))
    .returning({
      id: entityLink.id,
      fromEntityId: entityLink.fromEntityId,
      toEntityId: entityLink.toEntityId,
    });
}

/** Live `to` ids per `from` id, or the reverse for `end: "to"`. */
async function linkedIds(
  db: Pick<DrizzleTransaction, "select">,
  kind: EntityLinkKind,
  end: EntityLinkEnd,
  ids: readonly string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (ids.length === 0) return out;
  const rows = await db
    .select({ from: entityLink.fromEntityId, to: entityLink.toEntityId })
    .from(entityLink)
    .where(and(liveLinks(kind), inArray(endColumn(end), [...ids])))
    .orderBy(entityLink.createdAt, entityLink.id);
  for (const row of rows) {
    const [own, other] =
      end === "from" ? [row.from, row.to] : [row.to, row.from];
    out.set(own, [...(out.get(own) ?? []), other]);
  }
  return out;
}

/**
 * Serialize writers of one acyclic link kind, then refuse when the live graph
 * with `from`'s outgoing set replaced by `to` would contain a cycle. Row locks
 * cannot serialize two new opposite links (neither row exists yet), so each
 * kind takes one transaction-scoped advisory lock.
 */
export async function assertLinkSetAcyclic(
  tx: DrizzleTransaction,
  kind: EntityLinkKind,
  from: string,
  to: readonly string[],
): Promise<boolean> {
  await lockLinkKind(tx, kind);
  const current = await tx
    .select({ from: entityLink.fromEntityId, to: entityLink.toEntityId })
    .from(entityLink)
    .where(liveLinks(kind));
  const edges = [
    ...current.filter((edge) => edge.from !== from),
    ...to.map((target) => ({ from, to: target })),
  ];
  return findDirectedDependencyCycles(edges).length === 0;
}

async function lockLinkKind(
  tx: DrizzleTransaction,
  kind: EntityLinkKind,
): Promise<void> {
  const lockKey = `cubby:entity-link:${kind}`;
  await unwrapDb(tx).execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`,
  );
}

/**
 * Replace `from`'s full outgoing set of `kind` with `to`: links no longer
 * named are soft-deleted, new ones inserted, kept ones untouched. The caller
 * validates liveness, self-links and cycles first.
 */
export async function replaceLinkSet(
  tx: DrizzleTransaction,
  kind: EntityLinkKind,
  from: string,
  to: readonly string[],
): Promise<{ added: string[]; removed: string[] }> {
  const wanted = uniq(to);
  const current = (await linkedIds(tx, kind, "from", [from])).get(from) ?? [];
  const removed = current.filter((id) => !wanted.includes(id));
  const added = wanted.filter((id) => !current.includes(id));
  if (removed.length > 0)
    await softDeleteLinks(
      tx,
      kind,
      and(
        eq(entityLink.fromEntityId, from),
        inArray(entityLink.toEntityId, removed),
      ),
    );
  await attachLinks(
    tx,
    kind,
    added.map((target) => ({ from, to: target })),
  );
  return { added, removed };
}

type LinkRow = {
  id: string;
  fromEntityId: string;
  toEntityId: string;
  quantity: number | null;
};

type LinkRepointResult = {
  moved: number;
  /** Duplicates dropped (`dropLoser`, equal-quantity dedupe, self-links). */
  dropped: number;
  /** Duplicates whose quantity was summed into the survivor's link. */
  summed: number;
};

/**
 * Re-point one end of `kind` from merged-away entities onto the survivor,
 * resolving each collision with a live link the survivor already holds for
 * the same other end by the declared `onMergeCollision` of this end. A link
 * whose two ends both land on the survivor is dropped: it would be a
 * self-link. Runs before the losers are tombstoned (the live-endpoint trigger
 * refuses an update that leaves a live link on a deleted entity).
 */
export async function repointLinkEnd(
  tx: DrizzleTransaction,
  args: {
    kind: EntityLinkKind;
    end: EntityLinkEnd;
    keepId: string;
    loserIds: readonly string[];
    now?: Date;
  },
): Promise<LinkRepointResult> {
  const result: LinkRepointResult = { moved: 0, dropped: 0, summed: 0 };
  if (args.loserIds.length === 0) return result;
  const now = args.now ?? new Date();
  const declaration = ENTITY_LINK_KINDS[args.kind];
  const collision = (
    args.end === "from" ? declaration.fromEnd : declaration.toEnd
  ).onMergeCollision;
  const own = endColumn(args.end);
  const mergeSet = new Set([args.keepId, ...args.loserIds]);
  const rows: LinkRow[] = await tx
    .select({
      id: entityLink.id,
      fromEntityId: entityLink.fromEntityId,
      toEntityId: entityLink.toEntityId,
      quantity: entityLink.quantity,
    })
    .from(entityLink)
    .where(and(liveLinks(args.kind), inArray(own, [...mergeSet])))
    .orderBy(entityLink.createdAt, entityLink.id);
  const ownOf = (row: LinkRow) =>
    args.end === "from" ? row.fromEntityId : row.toEntityId;
  const otherOf = (row: LinkRow) =>
    args.end === "from" ? row.toEntityId : row.fromEntityId;

  const drop: string[] = [];
  const keeperByOther = new Map(
    rows
      .filter((row) => ownOf(row) === args.keepId)
      .map((row) => [otherOf(row), row] as const),
  );
  const losers = rows.filter((row) => ownOf(row) !== args.keepId);
  for (const [other, group] of Object.entries(groupBy(losers, otherOf))) {
    // Both ends inside the merge set: after the repoint it names the survivor
    // twice. Same-kind links only (a kit and its part, two dependent tasks).
    if (mergeSet.has(other)) {
      drop.push(...group.map((row) => row.id));
      continue;
    }
    const keeper = keeperByOther.get(other);
    const [first, ...rest] = group;
    if (!first) continue;
    const target = keeper ?? first;
    const absorbed = keeper ? group : rest;
    if (!keeper) {
      await tx
        .update(entityLink)
        .set(
          args.end === "from"
            ? { fromEntityId: args.keepId }
            : { toEntityId: args.keepId },
        )
        .where(eq(entityLink.id, first.id));
      result.moved += 1;
    }
    if (absorbed.length === 0) continue;
    switch (collision) {
      case "dropLoser":
        break;
      case "dedupeEqualQuantityElseRefuse":
        if (absorbed.some((row) => row.quantity !== target.quantity))
          throw createAppError(
            "PRODUCT_MERGE_COMPONENT_QUANTITY_MISMATCH",
            `Merging would list one ${declaration.to} twice on a ${args.kind} link with different quantities; reconcile the quantities first.`,
          );
        break;
      case "sumQuantity":
        await tx
          .update(entityLink)
          .set({
            quantity:
              (target.quantity ?? 0) +
              sumBy(absorbed, (row) => row.quantity ?? 0),
          })
          .where(eq(entityLink.id, target.id));
        result.summed += absorbed.length;
        break;
    }
    drop.push(...absorbed.map((row) => row.id));
  }
  if (drop.length > 0) {
    await tx
      .update(entityLink)
      .set({ deletedAt: now })
      .where(inArray(entityLink.id, drop));
    result.dropped = drop.length - result.summed;
  }
  if (declaration.acyclic) {
    const live = await tx
      .select({ from: entityLink.fromEntityId, to: entityLink.toEntityId })
      .from(entityLink)
      .where(liveLinks(args.kind));
    if (findDirectedDependencyCycles(live).length > 0)
      throw createAppError(
        "DEPENDENCY_CYCLE",
        `Merging would close a cycle of ${args.kind} links.`,
      );
  }
  return result;
}

/** The `[kind, end]` an `EntityLink[kind].end` edge key names, if it is one. */
export const parseLinkEdgeKey = (
  edgeKey: string,
): { kind: EntityLinkKind; end: EntityLinkEnd } | null => {
  const match = /^EntityLink\[(\w+)\]\.(from|to)$/u.exec(edgeKey);
  const kind = entityLinkKinds.find((candidate) => candidate === match?.[1]);
  const end = match?.[2];
  return kind && (end === "from" || end === "to") ? { kind, end } : null;
};
