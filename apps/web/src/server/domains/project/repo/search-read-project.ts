import { entitySchema } from "@cubby/schemas/entity";
import { parseEntityId } from "@cubby/schemas/identifiers";
import { sql, and, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { Database, DrizzleTransaction } from "~/server/db";
import { effectiveFieldSql } from "~/server/db/computed/effective-field";
import { unwrapDb, notDeleted } from "~/server/db/helpers";
import { project as searchTableproject } from "~/server/db/schema";
import { project } from "~/server/db/schema";
import { withOptionalLimit } from "~/server/generic/embedding/repo/embedding-load-options";
import { buildProjectEmbeddingText } from "~/server/generic/embedding/repo/semantic/text";
import type {
  EmbeddingLoadOptions,
  SearchableEntityText,
  SearchReadPort,
} from "~/server/generic/search/repo/search-read-port";

async function loadEmbeddingText(
  db: Database | DrizzleTransaction,
  options: EmbeddingLoadOptions = {},
): Promise<SearchableEntityText[]> {
  const queryConfig = withOptionalLimit(
    {
      where: and(
        notDeleted(project),
        options.ids?.length
          ? inArray(
              project.id,
              options.ids.map((id) => parseEntityId("project", id)),
            )
          : undefined,
      ),
      extras: {
        resolvedLocations: effectiveFieldSql<string[]>("project", "locations", {
          id: sql`"project"."id"`,
        }).as("resolvedLocations"),
      },
      columns: {
        id: true,
        name: true,
        status: true,
        kind: true,
        locations: true,
        notes: true,
      },
    },
    options.limit,
  );
  const rows = await unwrapDb(db).query.project.findMany(queryConfig);
  return rows.map((row) => ({
    entityKind: "project",
    entityId: row.id,
    embeddingText: buildProjectEmbeddingText({
      ...row,
      locations: row.resolvedLocations,
    }),
  }));
}
export const projectSearch = {
  document: ({ types, requested, bounded }) => sql`
      SELECT ${entitySchema.enum.project}, p."id"::text, p."shortcode", p."name", concat_ws(' · ', p."kind", p."status"), p."emoji", ARRAY[]::text[], ARRAY[p."kind", p."status"]::text[] || ${effectiveFieldSql("project", "locations", "p")}
      FROM "Project" p WHERE ${notDeleted(alias(searchTableproject, "p"))} AND ${entitySchema.enum.project} IN (${types}) AND ${requested(sql`p."id"`)} AND ${bounded(sql`p."createdAt"`)}`,
  embedding: loadEmbeddingText,
} satisfies SearchReadPort;
