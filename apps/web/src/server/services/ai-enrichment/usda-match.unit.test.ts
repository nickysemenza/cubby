import { testEntityId } from "@cubby/schemas/testing";
import { describe, expect, it } from "vitest";

import {
  createUsdaMatchService,
  type UsdaLookupPort,
  type UsdaMatchPorts,
} from "./usda-match";

interface TestDatabase {
  readonly scope: "usda-match";
}
const database: TestDatabase = { scope: "usda-match" };
const lookup: UsdaLookupPort = {
  listFoods: async () => ({ data: [], count: 0 }),
};

function ports(
  suggest: UsdaMatchPorts<TestDatabase>["suggest"],
): UsdaMatchPorts<TestDatabase> & {
  dispatched: Parameters<UsdaMatchPorts<TestDatabase>["dispatchRetries"]>[1][];
  lookedUp: string[];
} {
  const dispatched: Parameters<
    UsdaMatchPorts<TestDatabase>["dispatchRetries"]
  >[1][] = [];
  const lookedUp: string[] = [];
  return {
    dispatched,
    lookedUp,
    dispatchRetries: async (_database, jobs) => {
      dispatched.push(jobs);
      return undefined;
    },
    getIngredient: async (_database, id) => {
      lookedUp.push(id);
      return { name: "current name" };
    },
    suggest,
    servicesForRetry: async () => ({ usdaService: lookup }),
  };
}

describe("suggestUsdaFoodBatch", () => {
  it("degrades a failed lookup and schedules exactly its retry", async () => {
    const ingredientId = testEntityId(
      "ingredient",
      "00000000-0000-4000-8000-000000000001",
    );
    const adapter = ports(async () => {
      throw new Error("network blip");
    });

    const service = createUsdaMatchService(adapter);
    await expect(
      service.suggestUsdaFoodBatch(lookup, database, [
        { id: ingredientId, name: "AP flour" },
      ]),
    ).resolves.toEqual([
      {
        name: "AP flour",
        food: null,
        confidence: "low",
        reasoning: "Lookup failed.",
      },
    ]);
    expect(adapter.dispatched).toEqual([
      expect.objectContaining({
        jobs: [expect.objectContaining({ payload: { ingredientId } })],
      }),
    ]);
  });

  it("does not schedule a successful lookup with no match", async () => {
    const ingredientId = testEntityId(
      "ingredient",
      "00000000-0000-4000-8000-000000000002",
    );
    const adapter = ports(async () => ({
      food: null,
      confidence: "low",
      reasoning: "No suitable match found.",
    }));
    const service = createUsdaMatchService(adapter);
    await service.suggestUsdaFoodBatch(lookup, database, [
      { id: ingredientId, name: "unobtainium" },
    ]);
    expect(adapter.dispatched).toEqual([]);
  });
});

describe("retryUsdaMatch", () => {
  it("re-reads the current ingredient name and lets retry failures escape", async () => {
    const ingredientId = testEntityId(
      "ingredient",
      "00000000-0000-4000-8000-000000000003",
    );
    const adapter = ports(async (_service, _database, name) => {
      expect(name).toBe("current name");
      throw new Error("still down");
    });
    const service = createUsdaMatchService(adapter);
    await expect(
      service.retryUsdaMatch(database, ingredientId),
    ).rejects.toThrow("still down");
    expect(adapter.lookedUp).toEqual([ingredientId]);
  });
});
