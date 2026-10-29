import { tsModule } from "../../artifacts.ts";
import type { CompiledEntity, EntityArtifacts } from "../declarations.ts";
import { entityProjectionMaps } from "./capabilities.ts";

export function renderBrowserReadContracts(
  entities: readonly CompiledEntity[],
): EntityArtifacts[] {
  const projections = entityProjectionMaps(entities);
  return [
    {
      relativePath: "apps/web/src/entity/generated/entity-read-keys.gen.ts",
      source: tsModule({
        consts: [
          {
            name: "listEntities",
            value: projections.list.map(({ key }) => key),
          },
          {
            name: "detailEntities",
            value: projections.detail.map(({ key }) => key),
          },
          {
            name: "entityMutationOutputEntities",
            value: projections.crud.map(({ key }) => key),
          },
        ],
      }),
    },
    {
      relativePath: "apps/web/src/entity/generated/entity-lists.gen.ts",
      source: tsModule({
        exports: [
          {
            from: "../model/list-contracts",
            names: [
              "entityListInputFor",
              "entityListInputSchema",
              "entityListParamsFromParsed",
              "parseEntityListInput",
            ],
          },
          {
            from: "../model/list-contracts",
            typeOnly: true,
            names: [
              "EntityListInputByEntity",
              "EntityListParamsByEntity",
              "EntityListParseInput",
              "EntityListResultByEntity",
              "EntitySelectedListResultByEntity",
              "ListEntity",
            ],
          },
          { from: "./entity-read-keys.gen", names: ["listEntities"] },
        ],
      }),
    },
    {
      relativePath: "apps/web/src/entity/generated/entity-details.gen.ts",
      source: tsModule({
        exports: [
          {
            from: "../model/detail-contracts",
            names: [
              "entityDetailInputFor",
              "entityDetailInputSchema",
              "parseEntityDetailInput",
            ],
          },
          {
            from: "../model/detail-contracts",
            typeOnly: true,
            names: [
              "DetailEntity",
              "EntityDetailByEntity",
              "EntityDetailInputByEntity",
            ],
          },
          { from: "./entity-read-keys.gen", names: ["detailEntities"] },
        ],
      }),
    },
    {
      relativePath:
        "apps/web/src/entity/generated/entity-mutation-results.gen.ts",
      source: tsModule({
        exports: [
          {
            from: "../model/mutation-contracts",
            names: ["parseEntityMutationOutput"],
          },
          {
            from: "../model/mutation-contracts",
            typeOnly: true,
            names: ["EntityMutationOutputByEntity"],
          },
          {
            from: "./entity-read-keys.gen",
            names: ["entityMutationOutputEntities"],
          },
        ],
      }),
    },
  ];
}
