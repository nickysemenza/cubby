import { entityManifest } from "@cubby/schemas/entity-manifest";
import type { RelatednessOut } from "@cubby/schemas/relatedness";

import type { RelatednessInput } from "~/contracts/relatedness.contract";
import type { Database } from "~/server/db";
import { findSemanticNeighbours } from "~/server/generic/embedding/service/semantic-similarity";
import { readScalarOverlaps } from "~/server/generic/relatedness/repo/scalar-overlap";
import { hydrateSearchHitRefs } from "~/server/generic/search/service/search.service";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";

import { buildRelatednessLedger } from "./relatedness-ledger";

const productionDependencies = {
  findSemanticNeighbours,
  readScalarOverlaps,
  hydrateSearchHitRefs,
  resolveOrThrow,
};
type RelatednessDependencies = typeof productionDependencies;

/** One same-entity rail, driven entirely by the static signal declaration. */
export async function getEntityRelatedness(
  db: Database,
  input: RelatednessInput,
  dependencies: RelatednessDependencies = productionDependencies,
): Promise<RelatednessOut> {
  const signals = entityManifest[input.entity].relatednessSignals;
  if (!signals.length)
    throw new Error(`Relatedness signals are not declared for ${input.entity}`);
  const sourceId = await dependencies.resolveOrThrow(
    db,
    input.entity,
    input.id,
  );
  const contributions: Omit<RelatednessOut["items"][number], "entity">[] = [];
  let status: RelatednessOut["status"] = "ready";
  for (const signal of signals) {
    if (signal.kind === "semantic") {
      const semantic = await dependencies.findSemanticNeighbours(db, {
        ...input,
        target: input.entity,
        limit: signal.limit,
      });
      status = semantic.status;
      for (const { entity, similarity } of semantic.results) {
        if (entity.id === input.id) continue;
        const score = similarity * signal.weight;
        contributions.push({
          shortcode: entity.id,
          title: entity.title,
          score,
          evidence: [{ signal: signal.label, detail: null, weight: score }],
        });
      }
    } else {
      const overlaps = await dependencies.readScalarOverlaps(
        db,
        input.entity,
        sourceId,
        signal,
      );
      const hits = await dependencies.hydrateSearchHitRefs(
        db,
        overlaps.map(({ entityId }) => ({
          entityKind: input.entity,
          entityId,
        })),
      );
      const valuesById = new Map(
        overlaps.map((row) => [row.entityId, row.values]),
      );
      for (const hit of hits)
        contributions.push({
          shortcode: hit.id,
          title: hit.title,
          score: 0,
          evidence: [
            {
              signal: signal.label,
              detail: valuesById.get(hit.entityId)?.join(", ") ?? null,
              weight: 0,
            },
          ],
        });
    }
  }
  return { status, items: buildRelatednessLedger(input.entity, contributions) };
}
