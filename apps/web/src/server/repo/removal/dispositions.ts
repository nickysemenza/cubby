/**
 * The generic delete: an entity's declared `lifecycle.delete` policy, applied
 * to the database edge by edge from `INCOMING_EDGES`.
 *
 * Order is fixed — block checks → detach (and overrides) → child removals →
 * root removal — so a refusal never follows a write, and a child count is
 * taken before anything it counts is removed. `order` moves named edges to
 * the front of their phase, for a partial unique index that must be freed
 * before a sibling edge writes.
 *
 * Entity-specific behavior that no disposition expresses goes in the named
 * hooks: `expand` (a task's live subtasks die with it), `overrides` (a
 * location's children are promoted rather than orphaned), and
 * `beforeDelete`/`afterDelete` (effects that read or write outside the edge
 * set, such as re-deriving an image's capture after its sightings go).
 */

import type { ActorContext } from "@cubby/schemas/context";
import {
  type OperationDisposition,
  type PublicImpactItem,
  toPublicImpact,
} from "@cubby/schemas/entity-integrity";
import {
  type AuditableEntity,
  auditableEntities,
} from "@cubby/schemas/entity-manifest";
import {
  ENTITY_LABEL,
  ENTITY_NOT_FOUND_REASON,
  type EntityId,
  type ImageShortcode,
  parseEntityRef,
} from "@cubby/schemas/identifiers";
import { and, getTableColumns, inArray, notInArray } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";

import type { Database, DrizzleTransaction } from "~/server/db";
import { ENTITY_EDGE_SEMANTICS } from "~/server/db/entity-edge-semantics";
import {
  INCOMING_EDGES,
  type IncomingEdge,
} from "~/server/db/entity-incoming-edges";
import { entityAttachment } from "~/server/db/schema";
import { createAppError, createBlockedError } from "~/server/errors/app-error";
import { logAuditEntries } from "~/server/repo/audit-log";
import { notDeleted, withTransactionOn } from "~/server/repo/database-helpers";
import { countByTarget, impact } from "~/server/repo/impact";
import type { RemovableEntity } from "~/server/repo/removal/core";
import { type ChildCascade, removeEntity } from "~/server/repo/removal/entity";
import {
  lookupShortcodes,
  resolveAllOrThrow,
} from "~/server/repo/shortcode-resolver";
import {
  SHORTCODE_TABLE,
  type ShortcodeTable,
} from "~/server/repo/shortcode-utils";

type Policy = Readonly<Record<string, OperationDisposition>>;
type Tx = DrizzleTransaction;

export interface DeleteHooks<E extends RemovableEntity> {
  /** Grow the removal set before any disposition runs (e.g. subtasks). */
  expand?: (tx: Tx, ids: EntityId<E>[]) => Promise<EntityId<E>[]>;
  /** Entity-specific guards or effects after locking, before any edge. */
  beforeDelete?: (tx: Tx, ids: EntityId<E>[]) => Promise<void>;
  /** Entity-specific effects after the root removal, in the same tx. */
  afterDelete?: (tx: Tx, ids: EntityId<E>[]) => Promise<void>;
  /** An edge whose disposition is not a plain column write. */
  overrides?: Readonly<
    Record<string, (tx: Tx, ids: EntityId<E>[]) => Promise<void>>
  >;
  /** Edges applied first within their phase. */
  order?: readonly string[];
  /** The root's own removal; child effects are always per edge. */
  removal?: "soft" | "hard";
}

type EdgePhysical = {
  key: string;
  disposition: OperationDisposition;
  table: PgTable;
  column: PgColumn;
  softDeletable: boolean;
};

const physicalEdges = <E extends RemovableEntity>(
  entity: E,
  policy: Policy,
  order: readonly string[] = [],
): EdgePhysical[] => {
  const rank = (key: string) => {
    const index = order.indexOf(key);
    return index === -1 ? order.length : index;
  };
  return Object.entries(policy)
    .map(([key, disposition]) => {
      // SAFETY: each policy `satisfies IncomingEdgePolicy<E, …>`, so every key
      // names an edge of this entity.
      const edge = (INCOMING_EDGES[entity] as Record<string, IncomingEdge>)[
        key
      ]!;
      // SAFETY: INCOMING_EDGES is built only from Postgres schema columns.
      const column = edge.column as PgColumn;
      // SAFETY: as above — a Postgres column's table is a PgTable.
      const table = column.table as PgTable;
      return {
        key,
        disposition,
        table,
        column,
        softDeletable: "deletedAt" in getTableColumns(table),
      };
    })
    .sort((a, b) => rank(a.key) - rank(b.key));
};

/** The auditable entity whose own table an edge lives on, if any. */
const sourceEntityOf = (table: PgTable): AuditableEntity | null =>
  auditableEntities.find(
    (entity) =>
      // SAFETY: a widening read; an entity with no own table reads undefined.
      (SHORTCODE_TABLE as Partial<Record<string, PgTable>>)[entity] === table,
  ) ?? null;

const liveWhere = (edge: EdgePhysical) =>
  edge.softDeletable
    ? // SAFETY: `softDeletable` checked the table has a `deletedAt` column.
      notDeleted(edge.table as PgTable & { deletedAt: PgColumn })
    : undefined;

/**
 * Refuse when a block edge still has live referencing rows, naming every
 * blocked target and count. A row of the entity's own table that is itself
 * being removed never blocks.
 */
const assertNotBlocked = async <E extends RemovableEntity>(
  tx: Tx,
  entity: E,
  edges: readonly EdgePhysical[],
  ids: readonly string[],
): Promise<void> => {
  const own: ShortcodeTable = SHORTCODE_TABLE[entity];
  const blockers: { edge: EdgePhysical; byTargetId: Record<string, number> }[] =
    [];
  for (const edge of edges) {
    if (edge.disposition.effect !== "block") continue;
    const byTargetId = await countByTarget(tx, edge.table, edge.column, ids, {
      includeDeleted: !edge.softDeletable,
      extraWhere: edge.table === own ? notInArray(own.id, [...ids]) : undefined,
    });
    if (Object.values(byTargetId).some((n) => n > 0))
      blockers.push({ edge, byTargetId });
  }
  if (blockers.length === 0) return;

  const targets = [
    ...new Set(blockers.flatMap(({ byTargetId }) => Object.keys(byTargetId))),
  ];
  const kind: RemovableEntity = entity;
  const publicIds = await lookupShortcodes(
    tx,
    targets.map((id) => parseEntityRef(kind, id)),
  );
  // SAFETY: semantics keys are this entity's INCOMING_EDGES keys.
  const semantics = ENTITY_EDGE_SEMANTICS[entity] as Record<
    string,
    { label: string }
  >;
  const items: PublicImpactItem[] = [];
  const lines = blockers.map(({ edge, byTargetId }) => {
    const label = semantics[edge.key]?.label ?? edge.key;
    const item = impact({
      disposition: edge.disposition,
      edgeKey: edge.key,
      label,
      byTargetId,
    });
    if (item) {
      try {
        items.push(toPublicImpact(item, publicIds, "throw"));
      } catch {
        // SILENT: the refusal below carries the same facts as prose; a
        // missing public id must not replace it with a bookkeeping error.
      }
    }
    const detail = Object.entries(byTargetId)
      .map(([id, n]) => `${publicIds.get(id) ?? id} (${n})`)
      .join(", ");
    return `${label} [${edge.key}, ${edge.disposition.code}]: ${detail}. ${edge.disposition.description}`;
  });
  throw createBlockedError(
    "ENTITY_DELETE_BLOCKED",
    `Cannot delete ${ENTITY_LABEL[entity].toLowerCase()}: ${lines.join(" ")}`,
    items,
  );
};

/** Clear the FK on live referencing rows, auditing an auditable source. */
const detach = async (
  tx: Tx,
  actor: ActorContext,
  edge: EdgePhysical,
  ids: readonly string[],
): Promise<void> => {
  const where = and(inArray(edge.column, [...ids]), liveWhere(edge));
  const source = sourceEntityOf(edge.table);
  const columns = getTableColumns(edge.table);
  const detached =
    source && "id" in columns
      ? await tx
          .select({ id: columns.id!, from: edge.column })
          .from(edge.table)
          .where(where)
      : [];
  await tx
    .update(edge.table)
    .set({ [edge.column.name]: null })
    .where(where);
  if (source && detached.length > 0)
    await logAuditEntries(
      tx,
      actor,
      detached.map((row) => ({
        entityType: source,
        entityId: String(row.id),
        action: "update" as const,
        changes: { [edge.column.name]: { from: row.from, to: null } },
      })),
    );
};

/**
 * Apply every non-root disposition: blocks, then detaches and overrides.
 * Returns the child removals, in policy order, for `removeEntity`.
 */
export const applyDispositions = async <E extends RemovableEntity>(
  tx: Tx,
  args: {
    entity: E;
    policy: Policy;
    ids: EntityId<E>[];
    actor: ActorContext;
    hooks?: DeleteHooks<E>;
  },
): Promise<ChildCascade[]> => {
  const { entity, policy, ids, actor, hooks = {} } = args;
  const edges = physicalEdges(entity, policy, hooks.order);
  // A block override is the edge's own guard (it throws to refuse).
  for (const edge of edges)
    if (edge.disposition.effect === "block")
      await hooks.overrides?.[edge.key]?.(tx, ids);
  await assertNotBlocked(
    tx,
    entity,
    edges.filter((edge) => !hooks.overrides?.[edge.key]),
    ids,
  );

  const own: ShortcodeTable = SHORTCODE_TABLE[entity];
  const children: ChildCascade[] = [];
  for (const edge of edges) {
    const override = hooks.overrides?.[edge.key];
    if (override && edge.disposition.effect !== "block") {
      await override(tx, ids);
      continue;
    }
    switch (edge.disposition.effect) {
      case "detach":
        await detach(tx, actor, edge, ids);
        break;
      case "soft-delete":
      case "hard-delete": {
        // A self-edge's rows are the removal set itself (`expand`).
        if (edge.table === own) break;
        const hard =
          edge.disposition.effect === "hard-delete" || !edge.softDeletable;
        children.push(
          hard
            ? { table: edge.table, parentColumns: [edge.column], mode: "hard" }
            : {
                // SAFETY: `softDeletable` checked the `deletedAt` column.
                table: edge.table as PgTable & { deletedAt: PgColumn },
                parentColumns: [edge.column],
                auditKey:
                  edge.table === entityAttachment
                    ? "cascadedImages"
                    : `cascaded${edge.key.split(".")[0]}`,
              },
        );
        break;
      }
      case "block":
      case "preserve":
        break;
      default:
        throw new Error(
          `${edge.key}: ${edge.disposition.effect} is not a delete effect`,
        );
    }
  }
  return children;
};

/**
 * The whole policy-driven delete: resolve → lock → expand → hooks and
 * dispositions → root removal. Joins an open transaction.
 */
export const deleteByPolicy = async <E extends RemovableEntity>(
  db: Database | Tx,
  args: {
    entity: E;
    policy: Policy;
    /** Public ids, or `ids` for a caller that already holds uuids. */
    shortcodes?: readonly string[];
    ids?: readonly EntityId<E>[];
    actor: ActorContext;
  } & DeleteHooks<E>,
): Promise<PolicyDeleteResult<E>> => {
  const { entity, policy, shortcodes, actor, removal = "soft" } = args;
  return withTransactionOn(db, async (tx) => {
    const requested = [
      ...new Set(
        args.ids ?? (await resolveAllOrThrow(tx, entity, shortcodes ?? [])),
      ),
    ];
    if (requested.length === 0)
      return {
        ids: [],
        shortcodes: [],
        deleted: 0,
        detachedImageKeys: [],
        deletedImageShortcodes: [],
      };
    const own: ShortcodeTable = SHORTCODE_TABLE[entity];
    const locked = await tx
      .select({ id: own.id })
      .from(own)
      .where(and(inArray(own.id, requested), notDeleted(own)))
      .orderBy(own.id)
      .for("update");
    if (locked.length !== requested.length)
      throw createAppError(
        ENTITY_NOT_FOUND_REASON[entity],
        `${ENTITY_LABEL[entity]} selected for deletion is no longer live.`,
      );
    const ids = args.expand ? await args.expand(tx, requested) : requested;
    const removedShortcodes = (
      await tx
        .select({ shortcode: own.shortcode })
        .from(own)
        .where(inArray(own.id, ids))
    ).map((row) => String(row.shortcode));
    await args.beforeDelete?.(tx, ids);
    const children = await applyDispositions(tx, {
      entity,
      policy,
      ids,
      actor,
      hooks: args,
    });
    const removed = await removeEntity(tx, {
      entity,
      ids,
      removal,
      actor,
      children,
    });
    await args.afterDelete?.(tx, ids);
    return { ids, shortcodes: removedShortcodes, ...removed };
  });
};

/** What a policy-driven delete reports. */
export type PolicyDeleteResult<E extends RemovableEntity> = {
  ids: EntityId<E>[];
  /** Public ids of every removed row, `expand`ed ones included. */
  shortcodes: string[];
  deleted: number;
  detachedImageKeys: string[];
  deletedImageShortcodes: ImageShortcode[];
};

/** A repository `delete` that is its entity's policy, plus named hooks. */
export const policyDelete =
  <E extends RemovableEntity>(
    entity: E,
    policy: Policy,
    hooks: DeleteHooks<E> = {},
  ): ((
    db: Database,
    shortcodes: readonly string[],
    actor: ActorContext,
  ) => Promise<PolicyDeleteResult<E>>) =>
  (db, shortcodes, actor) =>
    deleteByPolicy(db, { entity, policy, shortcodes, actor, ...hooks });
