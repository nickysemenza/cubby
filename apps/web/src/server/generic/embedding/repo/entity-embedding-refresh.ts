import { embeddingArtifactState } from "@cubby/schemas/derived-refresh";
import type {
  SearchableEntity,
  SearchableEntityRef,
} from "@cubby/schemas/search";
import { and, eq, isNull, sql } from "drizzle-orm";

import { normalizeSearchText } from "~/lib/search-normalization";
import type { Database, DrizzleTransaction } from "~/server/db";
import {
  unwrapDb,
  isTransaction,
  withTransactionDatabase,
  databaseForTransaction,
} from "~/server/db/helpers";
import { notDeleted } from "~/server/db/helpers/predicates";
import { embeddingTextHash } from "~/server/generic/embedding/repo/semantic/hash";
import type { SearchableEntityText } from "~/server/generic/search/repo/search-read-port";
export type { SearchableEntityText } from "~/server/generic/search/repo/search-read-port";
import type { SemanticEmbeddingConfig } from "~/server/generic/embedding/service/semantic/config";

/** Selected immutable-artifact hashes for a bounded reference batch. */
export async function getStoredEmbeddingHashes(
  db: Database | DrizzleTransaction,
  refs: ReadonlyArray<SearchableEntityRef>,
  config: SemanticEmbeddingConfig,
): Promise<Map<string, string>> {
  if (refs.length === 0) return new Map();
  // A JS array interpolates as a row constructor, not a Postgres list — build
  // the VALUES rows with `sql.join`, mirroring `getSearchDocumentEmbeddingTexts`.
  const values = sql.join(
    refs.map((ref) => sql`(${ref.entityKind}::text, ${ref.entityId}::uuid)`),
    sql`, `,
  );
  const result = await unwrapDb(db).execute<{
    entityKind: SearchableEntity;
    entityId: string;
    embeddingHash: string;
  }>(sql`
    WITH refs("entityKind", "entityId") AS (VALUES ${values})
    SELECT ee."entityKind", ee."entityId"::text AS "entityId",
      ee."artifactHash" AS "embeddingHash"
    FROM refs
    JOIN "EntityEmbedding" ee
      ON ee."entityKind" = refs."entityKind"
      AND ee."entityId" = refs."entityId"
      AND ee.provider = ${config.provider}::text
      AND ee.model = ${config.model}::text
      AND ee.dimensions = ${config.dimensions}::integer
      AND ${notDeleted("ee")}
      AND ee."artifactState" = ${embeddingArtifactState.enum.selected} AND ee."artifactHash" IS NOT NULL
  `);
  return new Map(
    result.rows.map((row) => [
      `${row.entityKind}:${row.entityId}`,
      row.embeddingHash,
    ]),
  );
}

/** Test fixture for a selected artifact; production selection requires observed remote storage. */
export async function seedEntityEmbedding(
  db: Database | DrizzleTransaction,
  input: SearchableEntityText & {
    config: SemanticEmbeddingConfig;
    values?: readonly number[];
  },
): Promise<string> {
  const embeddingHash = await embeddingTextHash({
    entityKind: input.entityKind,
    ...input.config,
    text: normalizeSearchText(input.embeddingText),
  });
  const { entityEmbedding } = await import("~/server/db/schema");
  const { vectorPayloadHash } = await import("./embedding-artifact");
  return withTransactionDatabase(
    isTransaction(db) ? databaseForTransaction(db) : db,
    async (tx) => {
      const live = await unwrapDb(tx)
        .execute(sql`SELECT id FROM "SearchDocument"
      WHERE "entityKind"=${input.entityKind} AND "entityId"=${input.entityId}::uuid
        AND "semanticText"=${input.embeddingText} AND ${notDeleted("SearchDocument")} LIMIT 1 FOR UPDATE`);
      if (!live.rows.length)
        throw new Error(
          "Synthetic embedding needs a matching live search document",
        );
      await unwrapDb(tx)
        .update(entityEmbedding)
        .set({ deletedAt: new Date(), artifactState: "retired" })
        .where(
          and(
            eq(entityEmbedding.entityKind, input.entityKind),
            eq(entityEmbedding.entityId, input.entityId),
            isNull(entityEmbedding.deletedAt),
          ),
        );
      const [artifact] = await unwrapDb(tx)
        .insert(entityEmbedding)
        .values({
          entityKind: input.entityKind,
          entityId: input.entityId,
          embeddingText: input.embeddingText,
          embeddingHash,
          artifactHash: embeddingHash,
          ...input.config,
          artifactState: "selected",
          observedAt: new Date(),
          indexedAt: new Date(),
          vectorHash: input.values
            ? await vectorPayloadHash(input.values)
            : null,
        })
        .returning({ id: entityEmbedding.id });
      if (!artifact) throw new Error("Synthetic embedding was not stored");
      return artifact.id;
    },
  );
}

/**
 * One loader call per entity type for a whole set of ids. This replaced a
 * per-entity form that issued a single-id SELECT for every row in a refresh
 * wave — 3,945 of them in one production sample.
 */
export async function getEmbeddingTextsForRefs(
  db: Database | DrizzleTransaction,
  idsByType: ReadonlyMap<SearchableEntity, string[]>,
): Promise<SearchableEntityText[]> {
  // Lazy: domain repositories reach this module, and the scaffold registry
  // imports every repository.
  const { kernelScaffold } = await import("~/server/entity-kernel/scaffolds");
  const chunks = await Promise.all(
    [...idsByType].map(([entityKind, ids]) =>
      ids.length === 0
        ? Promise.resolve<SearchableEntityText[]>([])
        : (() => {
            const port = kernelScaffold(entityKind)?.search;
            if (!port) throw new Error(`${entityKind} has no search read port`);
            return port.embedding(db, { ids });
          })(),
    ),
  );
  return chunks.flat();
}
