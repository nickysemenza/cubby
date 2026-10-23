import type { DataCheck, ScoredEntity } from "@cubby/schemas/data-quality";
import { sql, type SQL } from "drizzle-orm";

import {
  entityQuality,
  entityQualityCheck,
} from "~/server/db/entity-quality-schema";
import type { ScoredTable } from "~/server/generic/data-quality/repo/registry";

export const storedCheckStateSql = (
  kind: ScoredEntity,
  check: DataCheck,
  t: ScoredTable,
): SQL =>
  sql`(SELECT dq_check.state FROM ${entityQualityCheck} dq_check
      WHERE dq_check."entityId" = ${t.id} AND dq_check.kind = ${kind}
        AND dq_check."checkKey" = ${check})`;

export const storedScoreSql = (kind: ScoredEntity, t: ScoredTable): SQL =>
  sql`(SELECT dq_quality.score FROM ${entityQuality} dq_quality
      WHERE dq_quality."entityId" = ${t.id} AND dq_quality.kind = ${kind})`;
