import {
  dataChecksByEntity,
  relatedDataQualityEntities,
  type ScoredEntity,
} from "@cubby/schemas/data-quality";
import { entitySchema, type Entity } from "@cubby/schemas/entity";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { problemQueryDeclarations } from "./problem-registry";
import { viewManifest } from "./view-manifest";

/**
 * Every `dataGaps` filter value pinned anywhere in the manifest has to name a
 * check id the generated schema still recognizes for that entity (or for one
 * of its `related` roll-up entities) — otherwise a check rename silently
 * empties the Problems section or saved view that filters on the old id,
 * rather than failing loudly.
 *
 * Two sources, deliberately not one: a saved view without a `problem` block
 * (e.g. `purchase/unsettled`) never reaches `problemQueryDeclarations()`, and
 * a problem-backed view's filters are only canonical once compiled through
 * `viewProblemDeclarations()`. Skipping problem-backed views here avoids
 * asserting the same pinned filter twice.
 */

type DataGapUsage = { label: string; entity: Entity; checkId: string };

const isScoredEntity = (entity: Entity): entity is ScoredEntity =>
  Object.hasOwn(dataChecksByEntity, entity);

const dataGapValues = (value: string | readonly string[]): string[] =>
  z.array(z.string()).safeParse(value).data ?? [z.string().parse(value)];

const fromViewManifest = (): DataGapUsage[] =>
  Object.entries(viewManifest).flatMap(([entityKey, views]) => {
    const parsed = entitySchema.safeParse(entityKey);
    if (!parsed.success) return [];
    const entity = parsed.data;
    return (views ?? []).flatMap((view) => {
      // Problem-backed views are asserted via `problemQueryDeclarations()`
      // below, which runs their filters through the same compiler the
      // Problems service does.
      if (view.problem) return [];
      return view.filters
        .filter((filter) => filter.id === "dataGaps")
        .flatMap((filter) =>
          dataGapValues(filter.value).map((checkId) => ({
            label: `view-manifest.ts ${entityKey}/${view.id}`,
            entity,
            checkId,
          })),
        );
    });
  });

const fromProblemRegistry = (): DataGapUsage[] =>
  problemQueryDeclarations().flatMap((definition) => {
    if (definition.source.kind !== "entity") return [];
    const { entity, filters } = definition.source;
    return filters
      .filter((filter) => filter.id === "dataGaps")
      .flatMap((filter) =>
        dataGapValues(filter.value).map((checkId) => ({
          label: `Problem "${definition.key}"`,
          entity,
          checkId,
        })),
      );
  });

const usages = [...fromViewManifest(), ...fromProblemRegistry()];

describe("dataGaps filter values", () => {
  // Guards the guard: if every declaration stopped using `dataGaps`, the
  // table below would vacuously pass without checking anything.
  it("finds at least one dataGaps usage to check", () => {
    expect(usages.length).toBeGreaterThan(0);
  });

  it.each(usages)(
    "$label pins a check id valid for its entity: $checkId",
    ({ entity, checkId }) => {
      if (!isScoredEntity(entity)) {
        throw new Error(
          `"${entity}" pins a dataGaps filter but declares no data-quality checks`,
        );
      }
      const ownChecks: readonly string[] = dataChecksByEntity[entity].options;
      const relatedChecks: readonly string[] = relatedDataQualityEntities[
        entity
      ].flatMap(
        (related): readonly string[] => dataChecksByEntity[related].options,
      );
      const valid = new Set([...ownChecks, ...relatedChecks]);
      // oxlint-disable-next-line vitest/valid-expect -- The second argument is an assertion label for this table-driven check.
      expect(
        valid.has(checkId),
        `"${checkId}" is not a check of "${entity}" or its related ` +
          `entities [${relatedDataQualityEntities[entity].join(", ")}]`,
      ).toBe(true);
    },
  );
});
