import { parseEntityId, type RecipeId } from "@cubby/schemas/identifiers";
import type { RecipeTotals } from "@cubby/schemas/recipe-shared";
import {
  searchableEntities,
  searchableEntitySchema,
} from "@cubby/schemas/search";
import { and, asc, gt, isNull } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db/database";
import { getDb } from "~/server/db/helpers";
import { recipe } from "~/server/db/retained-tables";
import { commitRecipeTotals } from "~/server/domains/recipe/repo/totals";
import {
  refreshFamilyInput,
  REFRESH_PAGE_SIZE,
} from "~/server/generic/derived-refresh/repo/families";
import { retireStillOrphanedSearchArtifacts } from "~/server/generic/embedding/repo/entity-embedding-cleanup";
import type { JobHandler, PreparedJobPage } from "~/server/generic/jobs/types";
import {
  getSearchDocumentSourceRepairPage,
  getSearchDocumentOrphanPage,
  prepareSearchDocuments,
  publishPreparedSearchDocuments,
  type SearchDocumentCursor,
} from "~/server/generic/search/repo/search-document";

const cursorSchema = z.object({
  after: z.string().optional(),
  phase: z.enum(["search", "vectors"]).optional(),
  entityKind: searchableEntitySchema.optional(),
  entityId: z.uuid().optional(),
});

/** Each family is a bounded corpus pass; Job owns its sole cursor and retry budget. */
type RecipePreparation = (
  db: Database,
  id: RecipeId,
) => Promise<{
  fingerprint: string;
  compute: () => Promise<RecipeTotals | null>;
}>;

export type RefreshFamilyPreparation = {
  prepareRecipe: RecipePreparation;
  prepareConversions: (
    db: Database,
    options: { after?: string; limit: number },
  ) => Promise<{
    nextCursor: string | null;
    publish: (tx: Database) => Promise<void>;
  }>;
  prepareEmbeddings: (
    db: Database,
    options: { cursor?: SearchDocumentCursor; pageSize: number },
  ) => Promise<{
    nextCursor: SearchDocumentCursor | null;
    publish: (tx: Database) => Promise<number>;
  } | null>;
};

export function createRefreshFamilyHandler(
  ports: RefreshFamilyPreparation,
): JobHandler {
  return {
    prepare: async (db, claim): Promise<PreparedJobPage> => {
      const { family } = refreshFamilyInput.parse(claim.input);
      const cursor = cursorSchema.parse(claim.cursor ?? {});
      const counters = (delta: Record<string, number>) => {
        const previous = z
          .record(z.string(), z.unknown())
          .safeParse(claim.result);
        return Object.fromEntries(
          Object.entries(delta).map(([key, amount]) => {
            const value = previous.success ? previous.data[key] : undefined;
            return [key, (typeof value === "number" ? value : 0) + amount];
          }),
        );
      };
      const searchCursor =
        cursor.entityKind && cursor.entityId
          ? { entityKind: cursor.entityKind, entityId: cursor.entityId }
          : undefined;
      switch (family) {
        case "search": {
          const page = await getSearchDocumentSourceRepairPage(
            db,
            [...searchableEntities],
            { cursor: searchCursor, pageSize: REFRESH_PAGE_SIZE },
          );
          const prepared = await prepareSearchDocuments(db, page.refs);
          return {
            page: {
              done: !page.nextCursor,
              ...(page.nextCursor ? { cursor: page.nextCursor } : {}),
            },
            publish: async (tx) => {
              if (
                JSON.stringify(await prepareSearchDocuments(tx, page.refs)) !==
                JSON.stringify(prepared)
              )
                throw new Error("Search inputs changed during preparation");
              await publishPreparedSearchDocuments(tx, prepared);
              return counters({
                scanned: page.scannedCount,
                missing: page.missingCount,
                stale: page.staleCount,
                rebuilt: prepared.entries.length,
              });
            },
          };
        }
        case "recipes": {
          // A recipe's authoritative closure can be large; one owner bounds each provider preparation.
          const rows = await getDb(db)
            .select({ id: recipe.id })
            .from(recipe)
            .where(
              and(
                isNull(recipe.deletedAt),
                cursor.after
                  ? gt(recipe.id, parseEntityId("recipe", cursor.after))
                  : undefined,
              ),
            )
            .orderBy(asc(recipe.id))
            .limit(1);
          const id = rows[0]?.id;
          if (!id) return { page: { done: true } };
          const prepare = ports.prepareRecipe;
          const prepared = await prepare(db, id);
          const totals = await prepared.compute();
          return {
            page: { done: false, cursor: { after: id } },
            publish: async (tx) => {
              if ((await prepare(tx, id)).fingerprint !== prepared.fingerprint)
                throw new Error("Recipe inputs changed during preparation");
              if (totals)
                await commitRecipeTotals(tx, {
                  updates: [{ id, totals }],
                  freshOnlyIds: [],
                });
            },
          };
        }
        case "conversions": {
          const prepared = await ports.prepareConversions(db, {
            after: cursor.after,
            limit: REFRESH_PAGE_SIZE,
          });
          return {
            page: {
              done: !prepared.nextCursor,
              ...(prepared.nextCursor
                ? { cursor: { after: prepared.nextCursor } }
                : {}),
            },
            publish: prepared.publish,
          };
        }
        case "embeddings": {
          const prepared = await ports.prepareEmbeddings(db, {
            cursor: searchCursor,
            pageSize: REFRESH_PAGE_SIZE,
          });
          if (!prepared)
            return { page: { done: true, result: { outcome: "unavailable" } } };
          return {
            page: {
              done: !prepared.nextCursor,
              ...(prepared.nextCursor ? { cursor: prepared.nextCursor } : {}),
            },
            publish: async (tx) =>
              counters({ published: await prepared.publish(tx) }),
          };
        }
        case "orphans": {
          if (cursor.phase === "vectors") {
            const { prepareEmbeddingCleanupPage } =
              await import("~/server/generic/embedding/repo/embedding-cleanup");
            const prepared = await prepareEmbeddingCleanupPage(
              db,
              cursor.after,
              REFRESH_PAGE_SIZE,
            );
            return {
              page: {
                done: !prepared.nextCursor,
                ...(prepared.nextCursor
                  ? { cursor: { phase: "vectors", after: prepared.nextCursor } }
                  : {}),
              },
              publish: prepared.publish,
            };
          }
          const page = await getSearchDocumentOrphanPage(db, {
            cursor: searchCursor,
            pageSize: REFRESH_PAGE_SIZE,
          });
          return {
            page: {
              done: false,
              cursor: page.nextCursor ?? { phase: "vectors" },
            },
            publish: async (tx) => {
              const retired = await retireStillOrphanedSearchArtifacts(
                tx,
                page.refs,
              );
              return counters({
                scanned: page.scannedCount,
                orphaned: page.orphanedCount,
                retired,
              });
            },
          };
        }
      }
    },
  };
}
