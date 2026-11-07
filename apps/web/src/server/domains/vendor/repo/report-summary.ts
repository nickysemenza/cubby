import type { ReportBlock, ReportTime } from "@cubby/schemas/entity-report";
import { countLabel } from "@cubby/shared/pluralize";
import { sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { unwrapDb } from "~/server/db/helpers";
import { notDeleted, actualExpenseSql } from "~/server/db/helpers/predicates";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";
const rankedRow = z.object({
  id: z.string(),
  name: z.string(),
  count: z.coerce.number().int().nonnegative(),
  total: z.coerce.number().int().nonnegative(),
  latest: z.string().nullable(),
});
export async function vendorFrequentProductsSummary(
  db: Database,
  code: string,
): Promise<ReportBlock[]> {
  const id = await resolveOrThrow(db, "vendor", code);
  const result = await unwrapDb(db).execute(
    sql`
    SELECT product."shortcode" AS id, product.name,
      count(DISTINCT p.id)::int AS count, count(*) OVER ()::int AS total,
      max(p.date)::text AS latest
    FROM "Purchase" p
    JOIN "Expense" e ON e."purchaseId" = p.id AND ${notDeleted("e")}
    JOIN "Product" product ON product.id = e."productId" AND ${notDeleted("product")}
    WHERE p."vendorId" = ${id} AND ${notDeleted("p")}
      AND ${sql.raw(actualExpenseSql("e"))}
    GROUP BY product.id, product."shortcode", product.name
    ORDER BY count(DISTINCT p.id) DESC, max(p.date) DESC NULLS LAST, product."shortcode"
    LIMIT 3
  `,
    "objects",
  );
  const rows = rankedRow.array().parse(result);
  return [
    {
      kind: "records",
      title: "Frequently bought Products",
      rows: rows.map((row) => ({
        entity: "product",
        id: row.id,
        title: row.name,
        trailing: countLabel(row.count, "purchase"),
        time: row.latest
          ? ({ kind: "date", value: row.latest } satisfies ReportTime)
          : undefined,
      })),
      totalCount: rows[0]?.total ?? 0,
      connection: {
        source: { entityKind: "vendor", entityId: code },
        viewKey: "relation:products",
      },
      footer: "Ranked by distinct actual Purchases from this Seller.",
      empty: "No Product-linked actual purchases recorded.",
    },
  ];
}
