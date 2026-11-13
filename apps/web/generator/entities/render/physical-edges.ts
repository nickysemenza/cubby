import { rawSource, generatedHeader } from "../../artifacts.ts";
import type { CompiledEntity, EntityArtifacts } from "../declarations.ts";

/** Every incoming edge is an explicit projection of a physical declaration. */
export const renderEntityEdgesArtifact = (
  entities: readonly CompiledEntity[],
): EntityArtifacts => ({
  relativePath: "apps/web/src/server/db/generated/entity-edges.gen.ts",
  source: rawSource(
    generatedHeader +
      'import type {Entity} from "@cubby/schemas/entity";\n' +
      'import type {EntityEdge} from "../entity-edge-types";\n' +
      'import {DECLARED_EDGE_ORDINARY,ENTITY_EDGE_OVERRIDES} from "./declared-edges.gen";\n' +
      "export const ENTITY_EDGES={" +
      entities
        .map(
          (entity) =>
            JSON.stringify(entity.key) +
            ":{...DECLARED_EDGE_ORDINARY[" +
            JSON.stringify(entity.key) +
            "],...ENTITY_EDGE_OVERRIDES[" +
            JSON.stringify(entity.key) +
            "]}",
        )
        .join(",\n") +
      "} as const satisfies Record<Entity,Record<string,EntityEdge>>;\n",
  ),
});
