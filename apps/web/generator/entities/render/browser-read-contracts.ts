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
  ];
}
