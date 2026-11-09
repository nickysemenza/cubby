import {
  dataChecksByEntity,
  type DataCheck,
  type ScoredEntity,
} from "@cubby/schemas/data-quality";
import { sql, type SQL } from "drizzle-orm";

import type { ScoredTable } from "~/server/generic/data-quality/repo/registry";

/**
 * QualitySnapshot holds the declared check outcomes (ADR 0025): each check state
 * is a key of its `checks` object. These are primary-key lookups, so they stay
 * valid under any FROM clause.
 */
export const storedCheckStateSql = (
  kind: ScoredEntity,
  check: DataCheck,
  t: ScoredTable,
): SQL =>
  sql`(SELECT dq.checks->>${check} FROM "QualitySnapshot" dq
      WHERE dq."entityId" = ${t.id} AND dq.kind = ${kind})`;

/**
 * How many published checks are unresolved; null when nothing applies, so an
 * unassessed record never ranks as complete. Worklists order by this.
 */
export const storedGapCountSql = (kind: ScoredEntity, t: ScoredTable): SQL =>
  // A key a rules change removed stays until republication; it is not a gap.
  sql`(SELECT nullif(count(*) FILTER (WHERE c.value <> ${"not_applicable"}), 0) * 0
        + count(*) FILTER (WHERE c.value = ${"gap"})
      FROM "QualitySnapshot" dq, jsonb_each_text(dq.checks) c
      WHERE dq."entityId" = ${t.id} AND dq.kind = ${kind}
        AND c.key = ANY(ARRAY[${sql.join(
          dataChecksByEntity[kind].options.map((check) => sql`${check}`),
          sql`, `,
        )}]::text[]))`;
