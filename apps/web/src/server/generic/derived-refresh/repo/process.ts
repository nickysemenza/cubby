import { parseEntityId, type RecipeId } from "@cubby/schemas/identifiers";
import type { RecipeTotals } from "@cubby/schemas/recipe-shared";
import {
  searchableEntities,
  searchableEntitySchema,
} from "@cubby/schemas/search";
import { and, asc, count, gt, isNull } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db/database";
import { getDb } from "~/server/db/helpers";
import { notDeleted } from "~/server/db/helpers/predicates";
import { recipe, searchDocument } from "~/server/db/retained-tables";
import { countProductCoverageSources } from "~/server/domains/product/repo/conversion-coverage";
import {
  commitRecipeTotals,
  selectStaleRecipeIds,
} from "~/server/domains/recipe/repo/totals";
import {
  routineStepHandler,
  type RoutineStepDriversFor,
} from "~/server/domains/run/repo/routine-run";
import {
  refreshFamilyInput,
  REFRESH_PAGE_SIZE,
} from "~/server/generic/derived-refresh/repo/families";
import { retireStillOrphanedSearchArtifacts } from "~/server/generic/embedding/repo/entity-embedding-cleanup";
import type { JobHandler } from "~/server/generic/jobs/types";
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
    scanned: number;
    changed: number;
    publish: (tx: Database) => Promise<void>;
  }>;
  /** Null when embeddings are not configured. */
  countEmbeddings: (db: Database) => Promise<number | null>;
  prepareEmbeddings: (
    db: Database,
    options: { cursor?: SearchDocumentCursor; pageSize: number },
  ) => Promise<{
    nextCursor: SearchDocumentCursor | null;
    pending: number;
    publish: (tx: Database) => Promise<number>;
  } | null>;
};

const countSearchDocuments = async (db: Database) => {
  const [row] = await getDb(db)
    .select({ n: count() })
    .from(searchDocument)
    .where(isNull(searchDocument.deletedAt));
  return row?.n ?? 0;
};

const VECTOR_PHASE = { phase: "vectors" };

const searchCursorOf = (at: Record<string, string> | null) => {
  const cursor = cursorSchema.parse(at ?? {});
  return cursor.entityKind && cursor.entityId
    ? { entityKind: cursor.entityKind, entityId: cursor.entityId }
    : undefined;
};

/** Each family is a bounded corpus pass over current source data. */
function refreshFamilyDrivers(
  ports: RefreshFamilyPreparation,
): RoutineStepDriversFor<"derived_refresh"> {
  return {
    search: {
      count: countSearchDocuments,
      page: async (db, at) => {
        const page = await getSearchDocumentSourceRepairPage(
          db,
          [...searchableEntities],
          { cursor: searchCursorOf(at), pageSize: REFRESH_PAGE_SIZE },
        );
        const prepared = await prepareSearchDocuments(db, page.refs);
        return {
          next: page.nextCursor,
          scanned: page.scannedCount,
          pending: page.refs.length,
          publish: async (tx) => {
            if (
              JSON.stringify(await prepareSearchDocuments(tx, page.refs)) !==
              JSON.stringify(prepared)
            )
              throw new Error("Search inputs changed during preparation");
            await publishPreparedSearchDocuments(tx, prepared);
            return {
              missing: page.missingCount,
              stale: page.staleCount,
              rebuilt: prepared.entries.length,
            };
          },
        };
      },
    },
    recipes: {
      count: async (db) => {
        const [row] = await getDb(db)
          .select({ n: count() })
          .from(recipe)
          .where(notDeleted(recipe));
        return row?.n ?? 0;
      },
      page: async (db, at) => {
        const { after } = cursorSchema.parse(at ?? {});
        // A recipe's authoritative closure can be large; one owner bounds each provider preparation.
        const rows = await getDb(db)
          .select({ id: recipe.id })
          .from(recipe)
          .where(
            and(
              isNull(recipe.deletedAt),
              after ? gt(recipe.id, parseEntityId("recipe", after)) : undefined,
            ),
          )
          .orderBy(asc(recipe.id))
          .limit(1);
        const id = rows[0]?.id;
        if (!id) return { next: null, scanned: 0, pending: 0 };
        const prepare = ports.prepareRecipe;
        const prepared = await prepare(db, id);
        const totals = await prepared.compute();
        // Fresh recipes are recomputed too, but only stale ones are work.
        const stale = (await selectStaleRecipeIds(db, [id])).length;
        return {
          next: { after: id },
          scanned: 1,
          pending: totals ? stale : 0,
          publish: async (tx) => {
            if ((await prepare(tx, id)).fingerprint !== prepared.fingerprint)
              throw new Error("Recipe inputs changed during preparation");
            if (totals)
              await commitRecipeTotals(tx, {
                updates: [{ id, totals }],
                freshOnlyIds: [],
              });
            return { recomputed: totals ? stale : 0 };
          },
        };
      },
    },
    conversions: {
      count: countProductCoverageSources,
      page: async (db, at) => {
        const prepared = await ports.prepareConversions(db, {
          after: cursorSchema.parse(at ?? {}).after,
          limit: REFRESH_PAGE_SIZE,
        });
        return {
          next: prepared.nextCursor ? { after: prepared.nextCursor } : null,
          scanned: prepared.scanned,
          pending: prepared.changed,
          publish: async (tx) => {
            await prepared.publish(tx);
            return { changed: prepared.changed };
          },
        };
      },
    },
    embeddings: {
      count: async (db) => (await ports.countEmbeddings(db)) ?? 0,
      page: async (db, at) => {
        const prepared = await ports.prepareEmbeddings(db, {
          cursor: searchCursorOf(at),
          pageSize: REFRESH_PAGE_SIZE,
        });
        if (!prepared) return null;
        return {
          next: prepared.nextCursor,
          scanned: prepared.pending,
          pending: prepared.pending,
          publish: async (tx) => ({ admitted: await prepared.publish(tx) }),
        };
      },
    },
    orphans: {
      count: countSearchDocuments,
      page: async (db, at) => {
        const cursor = cursorSchema.parse(at ?? {});
        if (cursor.phase === "vectors") {
          const { prepareEmbeddingCleanupPage } =
            await import("~/server/generic/embedding/repo/embedding-cleanup");
          const prepared = await prepareEmbeddingCleanupPage(
            db,
            cursor.after,
            REFRESH_PAGE_SIZE,
          );
          return {
            next: prepared.nextCursor
              ? { phase: "vectors", after: prepared.nextCursor }
              : null,
            scanned: 0,
            pending: prepared.pending,
            publish: async (tx) => {
              await prepared.publish(tx);
              return { vectors: prepared.pending };
            },
          };
        }
        const page = await getSearchDocumentOrphanPage(db, {
          cursor: searchCursorOf(at),
          pageSize: REFRESH_PAGE_SIZE,
        });
        return {
          next: page.nextCursor ?? VECTOR_PHASE,
          scanned: page.scannedCount,
          pending: page.orphanedCount,
          publish: async (tx) => ({
            retired: await retireStillOrphanedSearchArtifacts(tx, page.refs),
          }),
        };
      },
    },
  };
}

/** One `derived_refresh` Run per family pass that found work. */
export function createRefreshFamilyHandler(
  ports: RefreshFamilyPreparation,
): JobHandler {
  return routineStepHandler("derived_refresh", {
    key: (claim) => refreshFamilyInput.parse(claim.input).family,
    input: (family) => ({ kind: "derived_refresh", family }),
    drivers: refreshFamilyDrivers(ports),
  });
}
