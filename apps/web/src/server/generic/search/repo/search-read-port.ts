import type { SearchableEntity } from "@cubby/schemas/search";
import { and, inArray, sql, type AnyColumn, type SQL } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";

import { normalizeSearchText } from "~/lib/search-normalization";
import type { Database, DrizzleTransaction } from "~/server/db";
import { unwrapDb, notDeleted } from "~/server/db/helpers";
import type { Requested } from "~/server/db/helpers/requested";

export type SearchableEntityText = {
  entityKind: SearchableEntity;
  entityId: string;
  embeddingText: string;
};

export type EmbeddingLoadOptions = { ids?: string[]; limit?: number };

type SearchDocumentContext = {
  types: SQL;
  requested: Requested | undefined;
  bounded: (column: SQL) => SQL;
  entityIds?: readonly string[];
  page?: {
    cursor?: { entityKind: SearchableEntity; entityId: string };
    pageSize?: number;
    createdBefore?: string;
  };
};

export type SearchReadPort = {
  document: (context: SearchDocumentContext) => SQL;
  prefix?: (context: SearchDocumentContext) => SQL;
  embedding: (
    db: Database | DrizzleTransaction,
    options?: EmbeddingLoadOptions,
  ) => Promise<SearchableEntityText[]>;
};

/** Ordinary stored entities index their declared title and public text fields. */
export function storedSearchRead({
  entity,
  table,
  title,
  keywords,
  subtitle,
  typeHint,
}: {
  entity: SearchableEntity;
  table: PgTable & {
    id: AnyColumn;
    shortcode: AnyColumn;
    createdAt: AnyColumn;
    deletedAt?: AnyColumn;
  };
  title: AnyColumn;
  keywords: readonly AnyColumn[];
  subtitle?: AnyColumn;
  typeHint?: AnyColumn;
}): SearchReadPort {
  const text = sql<string>`concat_ws(' ', ${sql.join(
    [typeHint, title, subtitle, ...keywords]
      .filter((column) => column !== undefined)
      .map((column) => sql`${column}::text`),
    sql`, `,
  )})`;
  return {
    document: ({ types, requested, bounded }) => sql`
      SELECT ${entity}, ${table.id}::text, ${table.shortcode}, ${title},
        ${subtitle ?? sql`NULL::text`}, ${typeHint ?? sql`NULL::text`}, ARRAY[]::text[],
        ARRAY[${sql.join(
          keywords.map((column) => sql`${column}::text`),
          sql`, `,
        )}]::text[]
      FROM ${table} WHERE ${notDeleted(table)} AND ${entity} IN (${types})
        AND ${requested?.match({ entity, id: sql`${table.id}` }) ?? sql`TRUE`} AND ${bounded(sql`${table.createdAt}`)}`,
    embedding: async (db, options = {}) => {
      const query = unwrapDb(db)
        .select({
          entityId: sql<string>`${table.id}::text`,
          embeddingText: text,
        })
        .from(table)
        .where(
          and(
            notDeleted(table),
            options.ids?.length
              ? inArray(sql`${table.id}`, options.ids)
              : undefined,
          ),
        );
      const rows = await (options.limit === undefined
        ? query
        : query.limit(options.limit));
      return rows.map((row) => ({
        entityKind: entity,
        entityId: row.entityId,
        embeddingText: normalizeSearchText(row.embeddingText),
      }));
    },
  };
}
