/**
 * The shared tail of every non-merge entity removal.
 *
 * ## The invariant
 *
 * Root AGENTS.md: every path that removes an entity must soft-delete that
 * entity's `SearchDocument` and `EntityEmbedding` rows **in the same
 * transaction**. A live search artifact pointing at a removed id is permanent
 * damage — soft deletes aren't restorable, diagnostics flag it forever, and
 * until then search can return a result that no longer resolves.
 *
 * ## Why it lives here
 *
 * It used to be a hand-copied `softDeleteEntityEmbeddingsTx(tx, "<entity>", ids)`
 * at 21 call sites across 18 files, next to a hand-copied delete-audit block,
 * backstopped only by a runtime detector and a real-DB test whose whole job was
 * proving nobody forgot. `merge/core.ts` already closed that hole for merges by
 * deriving the cascade from the entity itself; {@link cascadeRemoval} extends
 * the same proof to everything else.
 *
 * Three things make it structural rather than conventional:
 *
 *  - **The cascade is derived from `entity`, never passed.** `isSearchable` is a
 *    type predicate over the manifest's own roster, so it cannot be disabled or
 *    aimed at the wrong entity type.
 *  - **Audit is inside and mandatory.** Unlike `finalizeMerge` (whose actor is
 *    optional because `mergeIngredients` genuinely has none), there is no
 *    skip-audit arm — that would reintroduce the hole. Callers reach for this
 *    function because they need the audit entries; the cascade rides along.
 *  - **`RemovalAuditEntry` can only be minted here.** Its symbol witness is
 *    module-private and added by the builder below, which is reachable only
 *    after the cascade. A hand-written `{action: "delete"}` no longer
 *    typechecks anywhere in the codebase.
 *
 * ## What it deliberately does not do
 *
 * It does not remove the entity's own rows. Removal statements differ per
 * entity (soft vs hard, which children cascade, which unique-index slot has to
 * be vacated first, and in what order) and several sites depend on that order —
 * `inventory/bulk.ts` hard-deletes emptied sources up front to free slot keys,
 * and `ingredient/merge.ts` hard-removes where the other merges soft-delete.
 * Absorbing the row removal is a separate, deeper front door; this is the tail
 * every one of those paths shares.
 *
 * Consequently the embedding is always *soft*-deleted regardless of how the row
 * died. A soft-deleted embedding is excluded from both semantic search and
 * orphan detection, so one cascade covers hard and soft removals alike and no
 * caller needs a mode flag — see `merge/core.ts` and `inventory/bulk.ts` for
 * the two hard-delete paths that rely on this.
 */

import type { ActorContext } from "@cubby/schemas/context";
import type { Entity } from "@cubby/schemas/entity";
import type {
  AuditableEntity,
  ShortcodeEntity,
} from "@cubby/schemas/entity-manifest";
import type { EntityId } from "@cubby/schemas/identifiers";
import type { SearchableEntity } from "@cubby/schemas/search";
import { searchableEntities } from "@cubby/schemas/search";

import type { DrizzleTransaction } from "~/server/db";
import type { AuditEntryInput } from "~/server/repo/audit-log";
import { logAuditEntries } from "~/server/repo/audit-log";
import { softDeleteEntitySearchArtifactsTx } from "~/server/repo/entity-embedding-cleanup";
import { softDeleteSuggestionDismissalsTx } from "~/server/repo/suggestion-dismissal";

/**
 * An entity a removal path can operate on: it writes audit rows and it has a
 * public shortcode (hence a branded id). The two rosters coincide today; the
 * intersection is what the function actually needs, so it stays written as one.
 */
export type RemovableEntity = AuditableEntity & ShortcodeEntity;

/**
 * Per-parent counts of what a removal cascaded, keyed by audit change key —
 * `{ cascadedImages: { [parentId]: 3 } }`. Rendered as a `{from: n, to: 0}`
 * diff on the parent's delete entry.
 */
export type CascadeCounts = Record<string, Record<string, number>>;

const removalWitness = Symbol("RemovalAuditEntry");

/** Delete audit entry minted only after this module completes its cascade. */
export type RemovalAuditEntry = {
  entityType: RemovableEntity;
  entityId: string;
  action: "delete";
  changes?: Record<string, { from: unknown; to: unknown }>;
  readonly [removalWitness]: true;
};

const SEARCHABLE = new Set<string>(searchableEntities);

/** Whether removing a row of this entity must cascade derived search state. */
const isSearchable = (entity: Entity): entity is SearchableEntity =>
  SEARCHABLE.has(entity);

/**
 * Delete audit entries for a batch of removed ids, attaching per-parent cascade
 * counts. Only counts > 0 are emitted, and an entry with no cascades gets
 * `changes: undefined`.
 *
 * Module-private on purpose: it is the only place a {@link RemovalAuditEntry}
 * is minted, and it is unreachable except through {@link cascadeRemoval}, which
 * has already run the embedding cascade by the time it calls this.
 */
const buildCascadeAuditEntries = (
  entityType: RemovableEntity,
  ids: readonly string[],
  cascades: CascadeCounts,
): RemovalAuditEntry[] =>
  ids.map((id) => {
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const [key, byParent] of Object.entries(cascades)) {
      const count = byParent[id] ?? 0;
      if (count > 0) changes[key] = { from: count, to: 0 };
    }
    return {
      entityType,
      entityId: id,
      action: "delete",
      changes: Object.keys(changes).length > 0 ? changes : undefined,
      [removalWitness]: true,
    };
  });

/**
 * Cascade a removal's derived state and record it: soft-delete the removed
 * ids' search embeddings, then emit their delete audit entries.
 *
 * Call it **after** the statements that actually remove the rows, inside the
 * same transaction. It never touches the entity's own table.
 *
 * `audit` picks the sink, and there are exactly two because both shapes exist
 * in the tree:
 *  - `{into}` — append to a buffer the caller flushes later, for paths that
 *    accumulate create/update entries and write one batch (`inventory/bulk.ts`,
 *    `product/merge.ts`'s absorbed stock rows, `purchase.ts`'s `splitExpense`).
 *  - `{actor}` — write immediately, for everything else and for paths whose
 *    earlier entries must land in their own batch first
 *    (`deletePurchasesWithPolicy`'s detach `update` entries).
 *
 * Returns `void`: `{into}` hands its entries back by mutation, and returning
 * them when `{actor}` has already written them invites double-logging.
 */
export const cascadeRemoval = async <E extends RemovableEntity>(
  tx: DrizzleTransaction,
  args: {
    entity: E;
    /**
     * Branded rather than `string`, so `{entity: "inventory", ids: productIds}`
     * is a compile error — the mis-targeting `finalizeMerge`'s looser
     * `<Id extends string>` still allows.
     */
    ids: readonly EntityId<E>[];
    audit: { into: AuditEntryInput[] } | { actor: ActorContext };
    counts?: CascadeCounts;
  },
): Promise<void> => {
  const { entity, ids, audit } = args;
  if (ids.length === 0) return;

  if (isSearchable(entity)) {
    await softDeleteEntitySearchArtifactsTx(tx, entity, [...ids]);
    await softDeleteSuggestionDismissalsTx(tx, entity, [...ids]);
  }

  const entries = buildCascadeAuditEntries(entity, ids, args.counts ?? {});
  if ("into" in audit) {
    audit.into.push(...entries);
    return;
  }
  await logAuditEntries(tx, audit.actor, entries);
};
