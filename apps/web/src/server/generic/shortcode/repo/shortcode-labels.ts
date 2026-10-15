import { entitySchema } from "@cubby/schemas/entity";
import { entityManifest } from "@cubby/schemas/entity-manifest";
import { parseShortcode } from "@cubby/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";

import type { Database, DrizzleTransaction } from "~/server/db";
import { unwrapDb } from "~/server/db/helpers";
import { labelSql } from "~/server/generic/entity-graph/repo/entity-graph";

/**
 * Display labels for shortcodes of any entity, using the same per-entity
 * label rule as the record graph (`labelSql`). Unknown or deleted codes are
 * absent from the map; callers fall back to the code itself.
 */
export async function shortcodeLabels(
  db: Database | DrizzleTransaction,
  codes: readonly string[],
): Promise<Map<string, string>> {
  const byEntity = new Map<string, Set<string>>();
  for (const code of codes) {
    const parsed = parseShortcode(code);
    if (!parsed) continue;
    const set = byEntity.get(parsed.type) ?? new Set();
    set.add(parsed.shortcode);
    byEntity.set(parsed.type, set);
  }
  const labels = new Map<string, string>();
  await Promise.all(
    [...byEntity].map(async ([entity, set]) => {
      const kind = entitySchema.parse(entity);
      const { dbTable, softDelete } = entityManifest[kind];
      if (!dbTable) return;
      const rows = await unwrapDb(db).execute(sql`
        SELECT t."shortcode" AS code, ${labelSql(kind, "t")} AS label
        FROM ${sql.identifier(dbTable)} t
        WHERE t."shortcode" IN (${sql.join(
          [...set].map((code) => sql`${code}`),
          sql`, `,
        )})${softDelete ? sql` AND t."deletedAt" IS NULL` : sql``}`);
      for (const row of z
        .array(z.object({ code: z.string(), label: z.string() }))
        .parse(rows.rows))
        labels.set(row.code, row.label);
    }),
  );
  return labels;
}
