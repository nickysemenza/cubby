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
export async function ingredientSellersSummary(
  db: Database,
  code: string,
): Promise<ReportBlock[]> {
  const id = await resolveOrThrow(db, "ingredient", code);
  const result = await unwrapDb(db).execute(
    sql`
    SELECT v."shortcode" AS id, v."name", count(DISTINCT p.id)::int AS count,
      count(*) OVER ()::int AS total, max(p.date)::text AS latest
    FROM "Product" product
    JOIN "Expense" e ON e."productId" = product.id AND ${notDeleted("e")}
    JOIN "Purchase" p ON p.id = e."purchaseId" AND ${notDeleted("p")}
    JOIN "Vendor" v ON v.id = p."vendorId" AND ${notDeleted("v")}
    WHERE product."ingredientId" = ${id} AND ${notDeleted("product")}
      AND ${sql.raw(actualExpenseSql("e"))}
    GROUP BY v.id, v."shortcode", v.name
    ORDER BY count(DISTINCT p.id) DESC, max(p.date) DESC NULLS LAST, v."shortcode"
    LIMIT 3
  `,
    "objects",
  );
  const rows = rankedRow.array().parse(result);
  return [
    {
      kind: "records",
      title: "Sellers by distinct actual Purchases",
      rows: rows.map((row) => ({
        entity: "vendor",
        id: row.id,
        title: row.name,
        trailing: countLabel(row.count, "purchase"),
        time: row.latest
          ? ({ kind: "date", value: row.latest } satisfies ReportTime)
          : undefined,
        lines: [
          { text: row.latest ? "Last purchase" : "Purchase date not recorded" },
        ],
      })),
      totalCount: rows[0]?.total ?? 0,
      connection: {
        source: { entityKind: "ingredient", entityId: code },
        viewKey: "vendors",
      },
      footer: "Ranked across linked Products; a shared Purchase counts once.",
      empty: "No actual purchases recorded for linked Products.",
    },
  ];
}
