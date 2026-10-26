import type { DataCheck, ScoredEntity } from "@cubby/schemas/data-quality";
import { sql, type SQL } from "drizzle-orm";

import type { ScoredTable } from "~/server/generic/data-quality/repo/registry";

/**
 * Stored quality is the `dataQuality` derived value (ADR 0021): the score is
 * its sort projection and each check state is a key of its `checks` object.
 * Both are primary-key lookups, so they stay valid under any FROM clause.
 */
export const storedCheckStateSql = (
  _kind: ScoredEntity,
  check: DataCheck,
  t: ScoredTable,
): SQL =>
  sql`(SELECT dq.value->'checks'->>${check} FROM "DerivedValue" dq
      WHERE dq."entityId" = ${t.id} AND dq.key = 'dataQuality')`;

export const storedScoreSql = (_kind: ScoredEntity, t: ScoredTable): SQL =>
  sql`(SELECT dq."sortNumber" FROM "DerivedValue" dq
      WHERE dq."entityId" = ${t.id} AND dq.key = 'dataQuality')`;
