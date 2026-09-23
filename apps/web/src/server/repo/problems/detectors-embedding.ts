/**
 * Embedding-coverage Problems detector.
 *
 * Finds live entities that have no embedding row — i.e. records semantic
 * search simply cannot see. (The mirror question — embedding rows whose
 * entity is gone — no longer has a detector: both removal-path invariants
 * soft-delete `SearchDocument`/`EntityEmbedding` in the same transaction as
 * the entity, so an orphaned row is structurally impossible rather than
 * something to detect.)
 *
 * Deliberately a pure SQL anti-join, NOT a reuse of the SearchDocument
 * embedding-backfill worklist: that path scans and hashes the complete catalog
 * — fine for a manual backfill, categorically unfit for the fast detector
 * group. The tradeoff is that we detect *missing* only, never *stale*. Missing
 * is the case worth a Problems section; stale drains through mutation side
 * effects.
 */

import type { EntityMissingEmbedding } from "@cubby/schemas/problems";
import {
  embeddableEntities,
  type EmbeddableEntity,
} from "@cubby/schemas/search";
import type { SQL } from "drizzle-orm";
import { and, eq, exists, isNull, notExists, sql } from "drizzle-orm";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";

import type { Database } from "~/server/db";
import {
  cookbook,
  entityEmbedding,
  financialAccount,
  gardenEntry,
  image,
  ingredient,
  inventoryEntry,
  location,
  meal,
  plant,
  planting,
  product,
  project,
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
  // Every embeddable entity has a shortcode, so a missing-embedding row
  // (unlike an orphaned one, whose entity may already be gone) can always be
  // resolved to a link.
  shortcodeColumn: AnyPgColumn;
  deletedAtColumn: AnyPgColumn;
  /**
   * Extra predicates the entity's embedding-text loader also enforces. Without
   * these the detector reports rows that can never be fixed: the loader would
   * skip them too, so they'd sit in the section forever after every backfill.
   */
  liveness?: (client: DbClient) => SQL | undefined;
};

// One entry per EmbeddableEntity, `satisfies`-checked so adding an embeddable
// entity is a compile error here until its table is wired up (same guarantee
// `liveIdLoaders` in entity-embedding-cleanup gives the orphan detector). The
// three searchable-but-not-embeddable financial entities (purchase,
// financialTransaction, expense) never get an `EntityEmbedding` row, so they
// are excluded here rather than reported as permanently "missing".
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
    // Recipe proxies are indexed as recipes, never as ingredients; the text
    // loader and SearchDocument population both exclude these rows.
    liveness: () => isNull(ingredient.recipeId),
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
  financialAccount: {
    table: financialAccount,
    idColumn: financialAccount.id,
    shortcodeColumn: financialAccount.shortcode,
    deletedAtColumn: financialAccount.deletedAt,
  },
  wish: {
    table: wish,
    idColumn: wish.id,
    shortcodeColumn: wish.shortcode,
    deletedAtColumn: wish.deletedAt,
  },
  plant: {
    table: plant,
    idColumn: plant.id,
    shortcodeColumn: plant.shortcode,
    deletedAtColumn: plant.deletedAt,
  },
  planting: {
    table: planting,
    idColumn: planting.id,
    shortcodeColumn: planting.shortcode,
    deletedAtColumn: planting.deletedAt,
  },
  gardenEntry: {
    table: gardenEntry,
    idColumn: gardenEntry.id,
    shortcodeColumn: gardenEntry.shortcode,
    deletedAtColumn: gardenEntry.deletedAt,
  },
  image: {
    table: image,
    idColumn: image.id,
    shortcodeColumn: image.shortcode,
    deletedAtColumn: image.deletedAt,
  },
} satisfies Record<EmbeddableEntity, EmbeddingSource>;

const sourceEntries = embeddableEntities.map(
  (entity): [EmbeddableEntity, EmbeddingSource] => [
    entity,
    embeddingSources[entity],
  ],
);

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
  entityType: EmbeddableEntity,
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

export const findEntitiesMissingEmbeddingsPage = async (
  db: Database,
  config: SemanticEmbeddingConfig,
  options: { limit?: number } = {},
): Promise<{ items: EntityMissingEmbedding[]; count: number }> => {
  const limit = options.limit ?? MISSING_EMBEDDING_SAMPLE_LIMIT;
  const client = getDb(db);
  const union = sql.join(
    sourceEntries.map(
      ([entityType, source], sourceOrder) => sql`
      SELECT
        ${entityType}::text AS "entityType",
        ${source.shortcodeColumn}::text AS "entityId",
        ${sourceOrder}::int AS "sourceOrder"
      FROM ${source.table}
      WHERE ${missingEmbeddingWhere(client, entityType, source, config)}
    `,
    ),
    sql` UNION ALL `,
  );
  const result = await client.execute<{
    entityType: EmbeddableEntity;
    entityId: string;
    totalCount: number;
  }>(sql`
    WITH missing AS (${union}), ranked AS (
      SELECT *, count(*) OVER ()::int AS "totalCount"
      FROM missing
    )
    SELECT "entityType", "entityId", "totalCount"
    FROM ranked
    ORDER BY "sourceOrder", "entityId"
    LIMIT ${limit}
  `);

  return {
    items: result.rows.map(({ entityType, entityId }) => ({
      entityType,
      entityId,
    })),
    count: Number(result.rows[0]?.totalCount ?? 0),
  };
};

/** Compatibility sample interface for focused callers. */
export const findEntitiesMissingEmbeddings = async (
  db: Database,
  config: SemanticEmbeddingConfig,
  options: { limit?: number } = {},
): Promise<EntityMissingEmbedding[]> =>
  (await findEntitiesMissingEmbeddingsPage(db, config, options)).items;

export const countEntitiesMissingEmbeddings = async (
  db: Database,
  config: SemanticEmbeddingConfig,
): Promise<number> =>
  (await findEntitiesMissingEmbeddingsPage(db, config, { limit: 1 })).count;
