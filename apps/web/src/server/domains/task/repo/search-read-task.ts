import { entitySchema } from "@cubby/schemas/entity";
import { parseEntityId } from "@cubby/schemas/identifiers";
import type { Trade } from "@cubby/schemas/task-fields";
import { sql, and, eq, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { Database, DrizzleTransaction } from "~/server/db";
import { effectiveFieldSql } from "~/server/db/computed/effective-field";
import { unwrapDb, notDeleted } from "~/server/db/helpers";
import {
  project as searchTableproject,
  product as searchTableproduct,
  task as searchTabletask,
} from "~/server/db/schema";
import { product, project, task } from "~/server/db/schema";
import { buildTaskEmbeddingText } from "~/server/generic/embedding/repo/semantic/text";
import type {
  EmbeddingLoadOptions,
  SearchableEntityText,
  SearchReadPort,
} from "~/server/generic/search/repo/search-read-port";

async function loadEmbeddingText(
  db: Database | DrizzleTransaction,
  options: EmbeddingLoadOptions = {},
): Promise<SearchableEntityText[]> {
  const query = unwrapDb(db)
    .select({
      id: task.id,
      name: task.name,
      status: task.status,
      trade: effectiveFieldSql<Trade | null>("task", "trade"),
      projectName: project.name,
      subjectProductName: product.name,
    })
    .from(task)
    .leftJoin(project, eq(effectiveFieldSql("task", "projectId"), project.id))
    .leftJoin(
      product,
      eq(effectiveFieldSql("task", "subjectProductId"), product.id),
    )
    .where(
      and(
        notDeleted(task),
        options.ids?.length
          ? inArray(
              task.id,
              options.ids.map((id) => parseEntityId("task", id)),
            )
          : undefined,
      ),
    );
  const rows =
    options.limit == null ? await query : await query.limit(options.limit);
  return rows.map((row) => ({
    entityKind: "task",
    entityId: row.id,
    embeddingText: buildTaskEmbeddingText(row),
  }));
}
export const taskSearch = {
  document: ({ types, requested, bounded }) => sql`
      SELECT ${entitySchema.enum.task}, t."id"::text, t."shortcode", t."name", p."name", ${effectiveFieldSql("task", "trade", "t")}, ARRAY[]::text[], ARRAY[${effectiveFieldSql("task", "trade", "t")}, sp."name"]::text[]
      FROM "Task" t LEFT JOIN "Project" p ON p."id" = ${effectiveFieldSql("task", "projectId", "t")} AND ${notDeleted(alias(searchTableproject, "p"))} LEFT JOIN "Product" sp ON sp."id" = ${effectiveFieldSql("task", "subjectProductId", "t")} AND ${notDeleted(alias(searchTableproduct, "sp"))}
      WHERE ${notDeleted(alias(searchTabletask, "t"))} AND ${entitySchema.enum.task} IN (${types}) AND ${requested(sql`t."id"`)} AND ${bounded(sql`t."createdAt"`)}`,
  embedding: loadEmbeddingText,
} satisfies SearchReadPort;
