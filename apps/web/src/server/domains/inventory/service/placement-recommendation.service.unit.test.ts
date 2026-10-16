import { testShortcode } from "@cubby/schemas/testing";
import { describe, expect, it } from "vitest";

import { createDatabase } from "~/server/db/database-runtime";

import {
  getPlacementRecommendation,
  type PlacementRecommendationPorts,
} from "./placement-recommendation.service";

const db = createDatabase(() => {
  throw new Error("Placement unit ports do not resolve a database runtime");
});

describe("getPlacementRecommendation", () => {
  it("does not invent a destination when the requested stock row no longer exists", async () => {
    const ports = {
      getInventoryEntryByShortcode: async () => null,
      getProductStockRows: async () => [],
      resolveOrThrow: async () => {
        throw new Error("A missing row cannot resolve a product");
      },
    } satisfies PlacementRecommendationPorts;

    await expect(
      getPlacementRecommendation(
        db,
        testShortcode("inventory", "INV-PARKED"),
        ports,
      ),
    ).resolves.toBeNull();
  });
});
