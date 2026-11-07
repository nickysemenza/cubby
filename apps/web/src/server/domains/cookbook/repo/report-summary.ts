import type { ReportBlock, ReportTime } from "@cubby/schemas/entity-report";
import { countLabel } from "@cubby/shared/pluralize";
import { sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { unwrapDb } from "~/server/db/helpers";
import { notDeleted } from "~/server/db/helpers/predicates";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";
const rankedRow = z.object({
  id: z.string(),
  name: z.string(),
  count: z.coerce.number().int().nonnegative(),
  total: z.coerce.number().int().nonnegative(),
  latest: z.string().nullable(),
});
export async function cookbookRecentRecipesSummary(
  db: Database,
  code: string,
): Promise<ReportBlock[]> {
  const id = await resolveOrThrow(db, "cookbook", code);
  const result = await unwrapDb(db).execute(
    sql`
    SELECT r."shortcode" AS id, r.name, count(DISTINCT m.id)::int AS count,
      count(*) OVER ()::int AS total, max(m.date)::text AS latest
    FROM "Recipe" r
    JOIN "MealRecipe" mr ON mr."recipeId" = r.id AND ${notDeleted("mr")}
    JOIN "Meal" m ON m.id = mr."mealId" AND ${notDeleted("m")}
    WHERE r."cookbookId" = ${id} AND ${notDeleted("r")}
    GROUP BY r.id, r."shortcode", r.name
    ORDER BY max(m.date) DESC NULLS LAST, r."shortcode"
    LIMIT 3
  `,
    "objects",
  );
  const rows = rankedRow.array().parse(result);
  return [
    {
      kind: "records",
      title: "Recipes cooked recently",
      rows: [
        ...rows.map((row) => ({
          entity: "recipe",
          id: row.id,
          title: row.name,
          trailing: countLabel(row.count, "meal"),
          time: row.latest
            ? ({ kind: "date", value: row.latest } satisfies ReportTime)
            : undefined,
        })),
        ...(rows.length
          ? [
              {
                entity: null,
                id: null,
                title: "All Recipes in this Cookbook",
                trailing: null,
                listLink: { entity: "recipe", filters: { cookbookId: code } },
              },
            ]
          : []),
      ],
      totalCount: rows[0]?.total ?? 0,
      empty: "No Meals recorded for this Cookbook's Recipes.",
    },
  ];
}
