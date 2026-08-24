import type { Entity } from "@cubby/schemas/entity";
import type { SearchableEntity } from "@cubby/schemas/search";
import { queryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";

export type EntityInspectorHealth = {
  counts: Partial<Record<Entity, number>>;
  search: Partial<
    Record<SearchableEntity, { documents: number; embeddings: number }>
  >;
};

const getEntityInspectorHealth = createServerFn({ method: "GET" }).handler(
  async (): Promise<EntityInspectorHealth> => {
    const [contextModule, dashboardModule, searchModule, drizzle] =
      await Promise.all([
        import("~/server/request-context"),
        import("~/server/repo/dashboard"),
        import("~/server/repo/search-document"),
        import("drizzle-orm"),
      ]);
    const context = contextModule.requireActor(
      await contextModule.createRequestContext({
        headers: getRequest().headers,
      }),
    );
    const [counts, rows] = await Promise.all([
      dashboardModule.getEntityCounts(context.db),
      searchModule.executeSearchDocumentSql<{
        entityType: SearchableEntity;
        documents: number;
        embeddings: number;
      }>(
        context.db,
        drizzle.sql`
        SELECT
          sd."entityType" AS "entityType",
          count(DISTINCT sd."entityId")::int AS documents,
          count(DISTINCT ee."entityId")::int AS embeddings
        FROM "SearchDocument" sd
        LEFT JOIN "EntityEmbedding" ee
          ON ee."entityType" = sd."entityType"
          AND ee."entityId" = sd."entityId"
          AND ee."deletedAt" IS NULL
        WHERE sd."deletedAt" IS NULL
        GROUP BY sd."entityType"
      `,
      ),
    ]);
    return {
      counts,
      search: Object.fromEntries(
        rows.map((row) => [
          row.entityType,
          { documents: row.documents, embeddings: row.embeddings },
        ]),
      ),
    };
  },
);

export const entityInspectorHealthQueryOptions = (enabled: boolean) =>
  queryOptions({
    queryKey: [["entity", "inspector-health"]],
    queryFn: ({ signal }) => getEntityInspectorHealth({ signal }),
    enabled,
    staleTime: 60_000,
  });
