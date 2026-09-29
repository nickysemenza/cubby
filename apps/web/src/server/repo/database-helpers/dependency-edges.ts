/**
 * "Blocked by" dependency links (`taskDependency`, `projectDependency` in
 * `EntityLink`): the full-replacement write both task/crud.ts and
 * project/crud.ts use, and its batched read twin. `from` is the blocked
 * entity, `to` the blocker. Removal soft-deletes the link.
 */

import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";
import {
  ENTITY_LABEL,
  ENTITY_NOT_FOUND_REASON,
  type EntityId,
  parseEntityId,
} from "@cubby/schemas/identifiers";
import { and, inArray } from "drizzle-orm";
import type { AnyPgColumn, AnyPgTable } from "drizzle-orm/pg-core";
import { uniq } from "es-toolkit";

import type { Database, DrizzleTransaction } from "~/server/db";
import { entityLink } from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import {
  assertLinkSetAcyclic,
  liveLinks,
  replaceLinkSet,
} from "~/server/repo/entity-links";

import { getDb } from "./core";
import { notDeleted } from "./query";

type DependencyEntity = Extract<ShortcodeEntity, "project" | "task">;

const DEPENDENCY_KIND = {
  project: "projectDependency",
  task: "taskDependency",
} as const satisfies Record<DependencyEntity, string>;

/**
 * Replace the full `blockedByIds` set for one entity, inside the caller's
 * transaction:
 *
 *   1. Dedupe `newIds`.
 *   2. Reject a self-reference (`id` blocked by itself) — SELF_DEPENDENCY.
 *   3. Verify every id is a live row in `opts.entityTable` — throws
 *      `ENTITY_NOT_FOUND_REASON[opts.entity]` listing the missing ids if not.
 *   4. Serialize writers of the family and reject any cycle in the whole
 *      resulting graph — DEPENDENCY_CYCLE.
 *   5. Soft-delete links no longer named, insert the new ones.
 */
export async function replaceDependencyEdges<E extends DependencyEntity>(
  tx: DrizzleTransaction,
  opts: {
    /** Table the incoming ids must exist (live) in. */
    entityTable: AnyPgTable & {
      id: AnyPgColumn;
      deletedAt: AnyPgColumn;
    };
    /**
     * Drives the link kind, the error label (`ENTITY_LABEL[entity]`) and the
     * AppErrorReason (`ENTITY_NOT_FOUND_REASON[entity]`) thrown when an
     * incoming id doesn't exist, so they can't drift out of sync.
     */
    entity: E;
  },
  id: EntityId<E>,
  newIds: EntityId<E>[],
): Promise<void> {
  const deduped = uniq(newIds);
  const label = ENTITY_LABEL[opts.entity];
  const lowerLabel = label.toLowerCase();
  // Every current `ENTITY_LABEL` value starts with either a consonant sound
  // or a true vowel sound (no silent-h / "u"-as-"you" cases), so a plain
  // first-letter check picks the right article for all of them.
  const article = /^[aeiou]/iu.test(lowerLabel) ? "An" : "A";

  if (deduped.includes(id)) {
    throw createAppError(
      "SELF_DEPENDENCY",
      `${article} ${lowerLabel} cannot be blocked by itself.`,
    );
  }

  if (deduped.length > 0) {
    const live = await tx
      .select({ id: opts.entityTable.id })
      .from(opts.entityTable)
      .where(
        and(
          inArray(opts.entityTable.id, deduped),
          notDeleted(opts.entityTable),
        ),
      );
    const liveIds = new Set(
      live.map((row) => parseEntityId(opts.entity, row.id)),
    );
    const missing = deduped.filter((depId) => !liveIds.has(depId));
    if (missing.length > 0) {
      throw createAppError(
        ENTITY_NOT_FOUND_REASON[opts.entity],
        `${label}(s) not found: ${missing.join(", ")}`,
      );
    }
  }

  const kind = DEPENDENCY_KIND[opts.entity];
  // The per-kind advisory lock inside serializes every writer of the family:
  // row locks cannot, because two new opposite links both start absent.
  if (!(await assertLinkSetAcyclic(tx, kind, id, deduped))) {
    throw createAppError(
      "DEPENDENCY_CYCLE",
      `${label} dependencies must remain acyclic.`,
    );
  }
  await replaceLinkSet(tx, kind, id, deduped);
}

/**
 * Read-side twin of {@link replaceDependencyEdges}: batched blocked-by /
 * blocking id lookups for a set of entities, one query per direction (never
 * one query per entity). Live links only.
 */
export async function dependencyIdsFor<E extends DependencyEntity>(
  db: Database,
  entity: E,
  ids: EntityId<E>[],
): Promise<{
  blockedBy: Map<EntityId<E>, EntityId<E>[]>;
  blocking: Map<EntityId<E>, EntityId<E>[]>;
}> {
  const blockedBy = new Map<EntityId<E>, EntityId<E>[]>();
  const blocking = new Map<EntityId<E>, EntityId<E>[]>();
  if (ids.length === 0) return { blockedBy, blocking };

  const kind = DEPENDENCY_KIND[entity];
  const selectCols = {
    own: entityLink.fromEntityId,
    blockedBy: entityLink.toEntityId,
  };
  const [blockedByRows, blockingRows] = await Promise.all([
    getDb(db)
      .select(selectCols)
      .from(entityLink)
      .where(and(liveLinks(kind), inArray(entityLink.fromEntityId, ids))),
    getDb(db)
      .select(selectCols)
      .from(entityLink)
      .where(and(liveLinks(kind), inArray(entityLink.toEntityId, ids))),
  ]);

  for (const row of blockedByRows) {
    const own = parseEntityId(entity, row.own);
    const blockedById = parseEntityId(entity, row.blockedBy);
    blockedBy.set(own, [...(blockedBy.get(own) ?? []), blockedById]);
  }
  for (const row of blockingRows) {
    const own = parseEntityId(entity, row.own);
    const blockedById = parseEntityId(entity, row.blockedBy);
    blocking.set(blockedById, [...(blocking.get(blockedById) ?? []), own]);
  }
  return { blockedBy, blocking };
}
