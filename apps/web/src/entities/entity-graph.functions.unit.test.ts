import { allEntities } from "@cubby/schemas/entity-manifest";
import type { Query } from "@tanstack/react-query";
import { fromPartial } from "@total-typescript/shoehorn";
import { describe, expect, it } from "vitest";

import { entityRipple } from "~/integrations/tanstack-query/cache-tags";
import { matchesTags } from "~/integrations/tanstack-query/operation-cache";

import { entityGraph } from "./entity-graph.functions";

describe("entity.graph cache coverage", () => {
  it.each([entityGraph.explore, entityGraph.graph, entityGraph.graphPaths])(
    "invalidates every entity for each graph query",
    (operation) => {
      const graphQuery = fromPartial<Query>({
        meta: { cacheTags: operation.definition.tags },
      });
      for (const entity of allEntities) {
        expect(matchesTags(entityRipple(entity))(graphQuery)).toBe(true);
      }
    },
  );
});
