import type { DataCheck, ScoredEntity } from "@cubby/schemas/data-quality";
import { sql, type SQL } from "drizzle-orm";

import {
  entityQuality,
  entityQualityCheck,
} from "~/server/db/entity-quality-schema";
import type {
  QualityReadContext,
  ScoredTable,
} from "~/server/generic/data-quality/repo/registry";

/** Only persisted rows: no source predicates or read-triggered repair. */
export const storedQualityRelation = (kind: ScoredEntity): SQL => sql`
  SELECT q."entityId", q.score, c.states
  FROM ${entityQuality} q
  LEFT JOIN (
    SELECT "entityId", jsonb_object_agg("checkKey", state) AS states
    FROM ${entityQualityCheck} WHERE kind = ${kind} GROUP BY "entityId"
  ) c ON c."entityId" = q."entityId"
  WHERE q.kind = ${kind}`;

export const storedCheckStateSql = (
  kind: ScoredEntity,
  check: DataCheck,
  t: ScoredTable,
  context?: QualityReadContext,
): SQL =>
  context?.derivedAlias
    ? sql`(${sql.identifier(context.derivedAlias)}.states ->> ${check})`
    : sql`(SELECT dq_check.state FROM ${entityQualityCheck} dq_check
      WHERE dq_check."entityId" = ${t.id} AND dq_check.kind = ${kind}
        AND dq_check."checkKey" = ${check})`;

export const storedScoreSql = (
  kind: ScoredEntity,
  t: ScoredTable,
  context?: QualityReadContext,
): SQL =>
  context?.derivedAlias
    ? sql`(${sql.identifier(context.derivedAlias)}.score)`
    : sql`(SELECT dq_quality.score FROM ${entityQuality} dq_quality
      WHERE dq_quality."entityId" = ${t.id} AND dq_quality.kind = ${kind})`;
