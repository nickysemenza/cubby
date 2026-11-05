/** Quality check snapshots use the entity's declared evaluator and waiver policy. */
import { scoredEntities } from "@cubby/schemas/data-quality";

import { derivedSink } from "~/server/generic/derived/repo/compute";
import type { DerivedAdapter } from "~/server/generic/derived/repo/compute";

import { prepareQualityPublications, publishQualitySnapshots } from "./stored";

export const qualityDerivedComputes: Record<string, DerivedAdapter> =
  Object.fromEntries(
    scoredEntities.map((kind) => [
      `quality.${kind}`,
      Object.assign(
        derivedSink({
          prepare: (db, ids) => prepareQualityPublications(db, kind, ids),
          publish: async (tx, ids, rows) => {
            const keep = new Set(ids);
            return publishQualitySnapshots(tx, {
              kind,
              ids,
              rows: rows.filter((row) => keep.has(row.entityId)),
            });
          },
        }),
        { preparationBatchSize: 200 },
      ),
    ]),
  );
