import type { DataCheck, ScoredEntity } from "@cubby/schemas/data-quality";
import { sql, type SQL } from "drizzle-orm";

import type { ScoredTable } from "~/server/generic/data-quality/repo/registry";

/**
 * Stored quality is the `dataQuality` derived value (ADR 0021): each check state
 * is a key of its `checks` object. These are primary-key lookups, so they stay
 * valid under any FROM clause.
 */
export const storedCheckStateSql = (
  _kind: ScoredEntity,
  check: DataCheck,
  t: ScoredTable,
): SQL =>
  sql`(SELECT dq.value->'checks'->>${check} FROM "DerivedValue" dq
      WHERE dq."entityId" = ${t.id} AND dq.key = 'dataQuality')`;

/**
 * How many published checks are unresolved; null when nothing applies, so an
 * unassessed record never ranks as complete. Worklists order by this.
 */
export const storedGapCountSql = (_kind: ScoredEntity, t: ScoredTable): SQL =>
  sql`(SELECT nullif(count(*) FILTER (WHERE c.value <> ${"not_applicable"}), 0) * 0
        + count(*) FILTER (WHERE c.value = ${"gap"})
      FROM "DerivedValue" dq, jsonb_each_text(dq.value->'checks') c
      WHERE dq."entityId" = ${t.id} AND dq.key = 'dataQuality')`;
