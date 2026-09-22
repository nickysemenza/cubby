import { generatedHeader } from "../../artifacts.ts";
import type { CompiledEntity, EntityArtifacts } from "../declarations.ts";

type ScoredEntity = CompiledEntity & {
  dataQuality: NonNullable<CompiledEntity["dataQuality"]>;
};

const scoredEntitiesFor = (
  entities: readonly CompiledEntity[],
): ScoredEntity[] =>
  entities.flatMap((entity) =>
    entity.dataQuality === null
      ? []
      : [{ ...entity, dataQuality: entity.dataQuality }],
  );

const record = (
  name: string,
  type: string,
  entries: readonly (readonly [string, string])[],
): string =>
  `export const ${name} = {\n${entries
    .map(([key, value]) => `  ${JSON.stringify(key)}: ${value},`)
    .join("\n")}\n} as const satisfies ${type};\n`;

/**
 * `data-quality-checks.gen.ts`: every declared check as one global enum plus
 * the per-check facts (`facet`, `weight`, `kind`, `label`, `message`, owning
 * entity) and per-entity rosters. `@cubby/schemas/data-quality` composes its
 * public schemas from this leaf; the web registry proves every check id has a
 * SQL binding against it.
 */
export const renderDataQualityArtifacts = (
  entities: readonly CompiledEntity[],
): EntityArtifacts[] => {
  const scored = scoredEntitiesFor(entities);
  const checks = scored.flatMap((entity) =>
    entity.dataQuality.checks.map((check) => ({
      entity: entity.key,
      ...check,
    })),
  );
  const checkIds = checks.map((check) => check.id);
  const byCheck = (pick: (check: (typeof checks)[number]) => string) =>
    checks.map((check) => [check.id, pick(check)] as const);
  const facetsOf = (entity: ScoredEntity): string[] => [
    ...new Set(entity.dataQuality.checks.map((check) => check.facet)),
  ];
  const source =
    generatedHeader +
    'import { z } from "zod";\n' +
    'import type { DataQualityCheckKind, DataQualityFacetName } from "../data-quality-facets";\n\n' +
    `export const scoredEntities = ${JSON.stringify(scored.map((entity) => entity.key))} as const;\n` +
    "export type ScoredEntity = (typeof scoredEntities)[number];\n\n" +
    `export const dataCheck = z.enum(${JSON.stringify(checkIds)});\n` +
    "export type DataCheck = z.infer<typeof dataCheck>;\n\n" +
    "/** Each scored entity's own checks, as a Zod enum, in declaration order. */\n" +
    `export const dataChecksByEntity = {\n${scored
      .map(
        (entity) =>
          `  ${JSON.stringify(entity.key)}: z.enum(${JSON.stringify(entity.dataQuality.checks.map((check) => check.id))}),`,
      )
      .join("\n")}\n} as const;\n` +
    "export type DataCheckOf<E extends ScoredEntity> = z.infer<(typeof dataChecksByEntity)[E]>;\n\n" +
    record(
      "dataCheckEntity",
      "Record<DataCheck, ScoredEntity>",
      byCheck((check) => JSON.stringify(check.entity)),
    ) +
    "\n" +
    record(
      "dataCheckFacet",
      "Record<DataCheck, DataQualityFacetName>",
      byCheck((check) => JSON.stringify(check.facet)),
    ) +
    "\n" +
    record(
      "dataCheckKind",
      "Record<DataCheck, DataQualityCheckKind>",
      byCheck((check) => JSON.stringify(check.kind)),
    ) +
    "\n" +
    record(
      "dataCheckWeight",
      "Record<DataCheck, number>",
      byCheck((check) => String(check.weight)),
    ) +
    "\n" +
    record(
      "dataCheckLabel",
      "Record<DataCheck, string>",
      byCheck((check) => JSON.stringify(check.label)),
    ) +
    "\n" +
    record(
      "dataCheckMessage",
      "Record<DataCheck, string>",
      byCheck((check) => JSON.stringify(check.message)),
    ) +
    "\n/** Facet order per entity: first appearance in the declared checks. */\n" +
    record(
      "dataQualityFacets",
      "Record<ScoredEntity, readonly DataQualityFacetName[]>",
      scored.map(
        (entity) => [entity.key, JSON.stringify(facetsOf(entity))] as const,
      ),
    ) +
    "\n/** Scored entities whose gaps roll up into this entity's `relatedGaps`. */\n" +
    record(
      "relatedDataQualityEntities",
      "Record<ScoredEntity, readonly ScoredEntity[]>",
      scored.map(
        (entity) =>
          [entity.key, JSON.stringify(entity.dataQuality.related)] as const,
      ),
    ) +
    "\n/** Entities whose table carries a `dataExceptions` jsonb column. */\n" +
    record(
      "dataQualityExceptionEntities",
      "Record<ScoredEntity, boolean>",
      scored.map(
        (entity) =>
          [entity.key, String(entity.dataQuality.exceptions)] as const,
      ),
    );
  return [
    {
      relativePath: "packages/schemas/src/generated/data-quality-checks.gen.ts",
      source,
    },
  ];
};
