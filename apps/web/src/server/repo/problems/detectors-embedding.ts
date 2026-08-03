/**
 * Embedding-coverage Problems detector.
 *
 * The mirror image of `findOrphanedEntityEmbeddings` (repo/entity-embedding-cleanup):
 * that one finds embedding rows whose entity is gone, this one finds live
 * entities that have no embedding row — i.e. records semantic search simply
 * cannot see. Both are needed; neither implies the other.
 *
 * Deliberately a pure SQL anti-join, NOT a reuse of the backfill's
 * `getStaleEmbeddingTextsForEntityTypes`: that path scans every searchable table, builds
 * the embedding text for every live row, and SHA-hashes each one — fine for a
 * manual backfill, categorically unfit for the fast detector group. The tradeoff
 * is that we detect *missing* only, never *stale* (a row whose text changed but
 * whose hash we'd have to compute to notice). Missing is the case worth a
 * Problems section; stale drains on its own via the mutation side-effects.
 */

import type { EntityMissingEmbedding } from "@cubby/schemas/problems";
import type { SearchableEntity } from "@cubby/schemas/search";
import type { SQL } from "drizzle-orm";
import { and, count, eq, exists, isNull, notExists, sql } from "drizzle-orm";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";
import type { Database } from "~/server/db";
import {
  cookbook,
  entityEmbedding,
  expense,
  financialAccount,
  financialTransaction,
  ingredient,
  inventoryEntry,
  location,
  meal,
  product,
  project,
  purchase,
  recipe,
  task,
  vendor,
  wish,
} from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import type { SemanticEmbeddingConfig } from "~/server/semantic/config";

// Sample cap for the section's item rows. The true figure comes from
// `countEntitiesMissingEmbeddings` — the section shows a sample, the button
// shows the count. Needed because a model swap invalidates the whole corpus at
// once (the predicate keys on provider/model/dimensions), and shipping ~3k rows
// to the browser to render twelve of them is pure waste. Mirrors
// NEVER_VERIFIED_SAMPLE_LIMIT in detectors-inventory.
const MISSING_EMBEDDING_SAMPLE_LIMIT = 100;

type DbClient = ReturnType<typeof getDb>;

type EmbeddingSource = {
  table: PgTable;
  idColumn: AnyPgColumn;
  // Every searchable entity is one of the twelve shortcode entities, so a
  // missing-embedding row (unlike an orphaned one, whose entity may already be
  // gone) can always be resolved to a link.
  shortcodeColumn: AnyPgColumn;
  deletedAtColumn: AnyPgColumn;
  /**
   * Extra predicates the entity's embedding-text loader also enforces. Without
   * these the detector reports rows that can never be fixed: the loader would
   * skip them too, so they'd sit in the section forever after every backfill.
   */
  liveness?: (client: DbClient) => SQL | undefined;
};

// One entry per SearchableEntity, `satisfies`-checked so adding a searchable
// entity is a compile error here until its table is wired up (same guarantee
// `liveIdLoaders` in entity-embedding-cleanup gives the orphan detector).
const embeddingSources = {
  product: {
    table: product,
    idColumn: product.id,
    shortcodeColumn: product.shortcode,
    deletedAtColumn: product.deletedAt,
  },
  recipe: {
    table: recipe,
    idColumn: recipe.id,
    shortcodeColumn: recipe.shortcode,
    deletedAtColumn: recipe.deletedAt,
  },
  ingredient: {
    table: ingredient,
    idColumn: ingredient.id,
    shortcodeColumn: ingredient.shortcode,
    deletedAtColumn: ingredient.deletedAt,
  },
  cookbook: {
    table: cookbook,
    idColumn: cookbook.id,
    shortcodeColumn: cookbook.shortcode,
    deletedAtColumn: cookbook.deletedAt,
  },
  location: {
    table: location,
    idColumn: location.id,
    shortcodeColumn: location.shortcode,
    deletedAtColumn: location.deletedAt,
  },
  inventory: {
    table: inventoryEntry,
    idColumn: inventoryEntry.id,
    shortcodeColumn: inventoryEntry.shortcode,
    deletedAtColumn: inventoryEntry.deletedAt,
    // getInventoryEmbeddingTexts INNER JOINs product + location with notDeleted
    // on both, so an entry whose product or location was soft-deleted can never
    // get a text built — and would otherwise be flagged permanently.
    liveness: (client) =>
      and(
        exists(
          client
            .select({ one: sql`1` })
            .from(product)
            .where(
              and(
                eq(product.id, inventoryEntry.productId),
                notDeleted(product),
              ),
            ),
        ),
        exists(
          client
            .select({ one: sql`1` })
            .from(location)
            .where(
              and(
                eq(location.id, inventoryEntry.locationId),
                notDeleted(location),
              ),
            ),
        ),
      ),
  },
  meal: {
    table: meal,
    idColumn: meal.id,
    shortcodeColumn: meal.shortcode,
    deletedAtColumn: meal.deletedAt,
  },
  project: {
    table: project,
    idColumn: project.id,
    shortcodeColumn: project.shortcode,
    deletedAtColumn: project.deletedAt,
  },
  task: {
    table: task,
    idColumn: task.id,
    shortcodeColumn: task.shortcode,
    deletedAtColumn: task.deletedAt,
  },
  vendor: {
    table: vendor,
    idColumn: vendor.id,
    shortcodeColumn: vendor.shortcode,
    deletedAtColumn: vendor.deletedAt,
  },
  purchase: {
    table: purchase,
    idColumn: purchase.id,
    shortcodeColumn: purchase.shortcode,
    deletedAtColumn: purchase.deletedAt,
    liveness: (client) =>
      exists(
        client
          .select({ one: sql`1` })
          .from(vendor)
          .where(and(eq(vendor.id, purchase.vendorId), notDeleted(vendor))),
      ),
  },
  financialAccount: {
    table: financialAccount,
    idColumn: financialAccount.id,
    shortcodeColumn: financialAccount.shortcode,
    deletedAtColumn: financialAccount.deletedAt,
  },
  financialTransaction: {
    table: financialTransaction,
    idColumn: financialTransaction.id,
    shortcodeColumn: financialTransaction.shortcode,
    deletedAtColumn: financialTransaction.deletedAt,
    liveness: (client) =>
      exists(
        client
          .select({ one: sql`1` })
          .from(financialAccount)
          .where(
            and(
              eq(financialAccount.id, financialTransaction.accountId),
              notDeleted(financialAccount),
            ),
          ),
      ),
  },
  expense: {
    table: expense,
    idColumn: expense.id,
    shortcodeColumn: expense.shortcode,
    deletedAtColumn: expense.deletedAt,
  },
  wish: {
    table: wish,
    idColumn: wish.id,
    shortcodeColumn: wish.shortcode,
    deletedAtColumn: wish.deletedAt,
  },
} satisfies Record<SearchableEntity, EmbeddingSource>;

const sourceEntries = Object.entries(embeddingSources) as [
  SearchableEntity,
  EmbeddingSource,
][];

/**
 * "This live row has no embedding under the *current* provider/model/dimensions."
 *
 * Keying on the model triple is intentional: an embedding written by a
 * superseded model is not usable by today's search, so it genuinely does need
 * regenerating. The consequence — a model swap flags the entire corpus at once —
 * is real and correct, and is why the item rows are sampled.
 */
const missingEmbeddingWhere = (
  client: DbClient,
  entityType: SearchableEntity,
  source: EmbeddingSource,
  config: SemanticEmbeddingConfig,
) =>
  and(
    isNull(source.deletedAtColumn),
    source.liveness?.(client),
    notExists(
      client
        .select({ one: sql`1` })
        .from(entityEmbedding)
        .where(
          and(
            eq(entityEmbedding.entityType, entityType),
            eq(entityEmbedding.entityId, source.idColumn),
            eq(entityEmbedding.provider, config.provider),
            eq(entityEmbedding.model, config.model),
            eq(entityEmbedding.dimensions, config.dimensions),
            notDeleted(entityEmbedding),
          ),
        ),
    ),
  );

/**
 * A capped sample of live entities with no embedding row. Runs the ten
 * anti-joins SEQUENTIALLY on purpose — the fast detector group shares one pinned
 * pg connection, which runs a single query at a time (see the note on
 * `traceAllSeq` in problems.service).
 */
export const findEntitiesMissingEmbeddings = async (
  db: Database,
  config: SemanticEmbeddingConfig,
  options: { limit?: number } = {},
): Promise<EntityMissingEmbedding[]> => {
  const limit = options.limit ?? MISSING_EMBEDDING_SAMPLE_LIMIT;
  const client = getDb(db);
  const found: EntityMissingEmbedding[] = [];

  for (const [entityType, source] of sourceEntries) {
    if (found.length >= limit) break;
    const rows = await client
      .select({ shortcode: source.shortcodeColumn })
      .from(source.table)
      .where(missingEmbeddingWhere(client, entityType, source, config))
      .limit(limit - found.length);
    for (const row of rows) {
      found.push({
        entityType,
        entityId: String(row.shortcode),
      });
    }
  }

  return found;
};

/** The true (uncapped) figure behind the sampled section — one COUNT per type. */
export const countEntitiesMissingEmbeddings = async (
  db: Database,
  config: SemanticEmbeddingConfig,
): Promise<number> => {
  const client = getDb(db);
  let total = 0;

  for (const [entityType, source] of sourceEntries) {
    const [row] = await client
      .select({ n: count() })
      .from(source.table)
      .where(missingEmbeddingWhere(client, entityType, source, config));
    total += row?.n ?? 0;
  }

  return total;
};
