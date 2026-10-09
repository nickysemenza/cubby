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
  it("parses under the web wire schemas", () => {
    expect(() =>
      fixtureSchema.parse(
        JSON.parse(
          readFileSync(
            new URL(
              "../../../../../packages/schemas/fixtures/relationship-discovery.json",
              import.meta.url,
            ),
            "utf8",
          ),
        ),
      ),
    ).not.toThrow();
  });
});
