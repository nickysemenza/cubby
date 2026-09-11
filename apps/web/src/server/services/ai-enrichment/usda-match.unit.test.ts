import { testEntityId } from "@cubby/schemas/testing";
import type { FoodSummaryWithLinkedProducts } from "@cubby/schemas/usda";
import { describe, expect, it } from "vitest";

import { Database } from "~/server/db";

import {
  createUsdaMatchService,
  suggestUsdaFood,
  type UsdaLookupPort,
  type UsdaMatchAiPort,
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

const db = new Database(() => {
  throw new Error("usda-match unit ports do not resolve a database runtime");
});

function usdaFood(
  fdc_id: number,
  description: string,
): FoodSummaryWithLinkedProducts {
  return {
    fdc_id,
    foodInfo: { data_type: "sr_legacy_food", description },
    legacyFoodInfo: { ndb_number: 1100 },
    brandedFoodInfo: null,
    nutritionInfo: { nutrientSummary: [], nutrientsPer100: {} },
    portionInfoRaw: [],
    inferredUnitMappings: [],
    linkedProducts: [],
  };
}

describe("suggestUsdaFood", () => {
  // Every variant search returns the same two foods regardless of query text,
  // so the shortlist is deterministic without pinning the exact WASM-derived
  // query strings for "AP flour".
  const foodA = usdaFood(501, "Wheat flour, whole-grain");
  const foodB = usdaFood(502, "Wheat flour, white, all-purpose");
  const shortlistLookup: UsdaLookupPort = {
    listFoods: async () => ({ data: [foodA, foodB], count: 2 }),
  };

  it("calls the selector exactly once", async () => {
    let calls = 0;
    const ai: UsdaMatchAiPort = {
      select: async (_spec, args) => {
        calls += 1;
        return {
          selected: args.candidates[0] ?? null,
          confidence: "high",
          reasoning: "matched",
        };
      },
    };

    const result = await suggestUsdaFood(
      shortlistLookup,
      db,
      "AP flour",
      {},
      ai,
    );

    expect(calls).toBe(1);
    expect(result.food?.fdc_id).toBe(501);
  });

  it("resolves an off-shortlist id to food: null while keeping the model's reasoning", async () => {
    const ai: UsdaMatchAiPort = {
      select: async () => ({
        selected: null,
        confidence: "low",
        reasoning: "hallucinated an fdcId",
      }),
    };

    await expect(
      suggestUsdaFood(shortlistLookup, db, "AP flour", {}, ai),
    ).resolves.toEqual({
      food: null,
      confidence: "low",
      reasoning: "hallucinated an fdcId",
    });
  });

  it("shows the selector a rendered shortlist that contains every fdcId", async () => {
    let renderedLines: string[] = [];
    const ai: UsdaMatchAiPort = {
      select: async (spec, args) => {
        renderedLines = args.candidates.map((candidate) =>
          spec.renderLine(candidate),
        );
        return { selected: null, confidence: "low", reasoning: "n/a" };
      },
    };

    await suggestUsdaFood(shortlistLookup, db, "AP flour", {}, ai);

    expect(renderedLines.some((line) => line.includes("FDC 501"))).toBe(true);
    expect(renderedLines.some((line) => line.includes("FDC 502"))).toBe(true);
  });

  it("never calls the selector when the shortlist is empty", async () => {
    const emptyLookup: UsdaLookupPort = {
      listFoods: async () => ({ data: [], count: 0 }),
    };
    let calls = 0;
    const ai: UsdaMatchAiPort = {
      select: async () => {
        calls += 1;
        return { selected: null, confidence: "low", reasoning: "n/a" };
      },
    };

    await expect(
      suggestUsdaFood(emptyLookup, db, "unobtainium", {}, ai),
    ).resolves.toEqual({
      food: null,
      confidence: "low",
      reasoning: "No USDA candidates found.",
    });
    expect(calls).toBe(0);
  });
});
