import { readFileSync } from "node:fs";

import { entityGraphExploreOutputSchema } from "@cubby/schemas/entity-graph";
import { entityRecommendationsOut } from "@cubby/schemas/entity-recommendations";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const fixtureSchema = z.object({
  exploration: entityGraphExploreOutputSchema,
  recommendations: entityRecommendationsOut,
  inventoryRecommendations: entityRecommendationsOut,
  productRecommendations: entityRecommendationsOut,
});

describe("shared web and Swift relationship fixture", () => {
  it("preserves the three-hop evidence and typed recommendation action", () => {
    const fixture = fixtureSchema.parse(
      JSON.parse(
        readFileSync(
          new URL(
            "../../../../../packages/schemas/fixtures/relationship-discovery.json",
            import.meta.url,
          ),
          "utf8",
        ),
      ),
    );
    expect(fixture.exploration.paths.at(-1)?.edgeIds).toHaveLength(3);
    expect(fixture.exploration.completion.status).toBe("depth-limit");
    const group = fixture.recommendations.groups[0];
    if (group?.kind !== "expense-project")
      throw new Error("Expected expense proposals");
    expect(group.currentTarget?.id).toBe("PRJ-4K7M");
    expect(group.proposals[0]).toMatchObject({
      kind: "expense-project",
      target: { id: "PRJ-7M4K" },
      sameTradeCount: 2,
      exactProductCount: 1,
    });
    expect(group.proposals[0]?.supportingExpenses[0]?.id).toBe(
      fixture.exploration.paths.at(-1)?.nodeRefs[2]?.entityId,
    );
    expect(fixture.inventoryRecommendations.groups[0]).toMatchObject({
      kind: "inventory-placement",
      status: "ready",
      currentTarget: { id: "LOC-4K7M" },
      proposals: [{ target: { id: "LOC-7M4K" } }],
    });
    expect(fixture.productRecommendations.groups[0]).toMatchObject({
      kind: "product-related",
      status: "unavailable",
      proposals: [
        { target: { id: "PRD-7M4K" }, evidence: [{ signal: "Shared tags" }] },
      ],
    });
  });
});
