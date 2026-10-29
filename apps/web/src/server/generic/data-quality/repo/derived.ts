/**
 * Stored quality as a derived value (ADR 0021): each scored entity's
 * `dataQuality` recomputes through its stored evaluator, waivers applied.
 */
import { scoredEntities, type ScoredEntity } from "@cubby/schemas/data-quality";

import type {
  DerivedCompute,
  DerivedComputed,
} from "~/server/generic/derived/repo/compute";

import { prepareQualityPublications } from "./stored";

const qualityCompute = (kind: ScoredEntity): DerivedCompute => {
  const compute: DerivedCompute = async (db, ids) => {
    const out = new Map<string, DerivedComputed>();
    for (const row of await prepareQualityPublications(db, kind, ids))
      out.set(row.entityId, {
        value: {
          rulesVersion: row.rulesVersion,
          score: row.score,
          checks: row.checks,
        },
        sort: row.score,
      });
    return out;
  };
  return Object.assign(compute, { preparationBatchSize: 200 });
};

export const qualityDerivedComputes: Record<string, DerivedCompute> =
  Object.fromEntries(
    scoredEntities.map((kind) => [`quality.${kind}`, qualityCompute(kind)]),
  );
