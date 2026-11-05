import { sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { entityStoredDerivedDeclarations } from "~/server/db/derived-declarations";
import { productCostViewSql } from "~/server/domains/product/repo/cost-sql";

/** View adapters use the same canonical SQL as domain reads; ownership stays on the manifest. */
const viewQueries = new Map<string, SQL>([
  ["product.cost", productCostViewSql],
]);

/** Used only by migration generation and the scratch catalog model. */
export function renderDeclaredDerivedViews(): string {
  return entityStoredDerivedDeclarations()
    .filter((entry) => entry.snapshotSource?.view)
    .map((entry) => {
      const query = viewQueries.get(entry.compute);
      if (!query || !entry.snapshotSource)
        throw new Error(`Missing declared view SQL: ${entry.target}`);
      return (
        new PgDialect().sqlToQuery(
          sql`CREATE OR REPLACE VIEW ${sql.identifier(entry.snapshotSource.table)} AS ${query}`.inlineParams(),
        ).sql + ";"
      );
    })
    .join("\n");
}
