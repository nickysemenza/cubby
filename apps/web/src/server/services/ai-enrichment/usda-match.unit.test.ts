import { unsafeIngredientId } from "@cubby/schemas/identifiers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "~/server/db";
import type { USDAService } from "~/server/services/usda.service";

// suggestUsdaFood drives an agentic chat() loop (search tool -> select tool)
// against the real Anthropic client. None of that is under test here — only
// the Promise.allSettled fan-out in suggestUsdaFoodBatch, and retryUsdaMatch's
// re-fetch/throw behavior — so the AI plumbing is stubbed down to "an empty
// chat stream that never calls select_food", which makes suggestUsdaFood
// resolve to a genuine "no match" for every item. The reject-vs-resolve
// distinction the tests care about is driven entirely through the fake
// USDAService's listFoods (see the pre-seed search in suggestUsdaFood, which
// runs — and can throw — before chat() is ever reached).
const mocks = vi.hoisted(() => ({
  dispatchBackgroundJobs: vi.fn(),
  getIngredientByID: vi.fn(),
  buildCrudServices: vi.fn(),
}));

vi.mock("~/server/background-dispatch", () => ({
  dispatchBackgroundJobs: mocks.dispatchBackgroundJobs,
}));
vi.mock("~/server/repo/ingredient", () => ({
  getIngredientByID: mocks.getIngredientByID,
}));
vi.mock("~/server/request-context", () => ({
  buildCrudServices: mocks.buildCrudServices,
}));
vi.mock("~/server/clients/anthropic", () => ({
  getAnthropicClient: () => ({ getTextAdapter: () => ({}) }),
}));
vi.mock("@tanstack/ai", () => ({
  chat: vi.fn(() => (async function* emptyStream() {})()),
  maxIterations: (n: number) => n,
  toolDefinition: (def: unknown) => ({
    server: (handler: unknown) => ({ ...(def as object), handler }),
  }),
}));

import { retryUsdaMatch, suggestUsdaFoodBatch } from "./usda-match";

const db = {} as Database;

function fakeUsdaService(listFoods: USDAService["listFoods"]): USDAService {
  return { listFoods } as unknown as USDAService;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("suggestUsdaFoodBatch", () => {
  it("dispatches exactly one usda-match.retry job for an item whose lookup rejects, and still returns a degraded entry", async () => {
    const ingredientId = unsafeIngredientId(
      "00000000-0000-4000-8000-000000000001",
    );
    const usdaService = fakeUsdaService(
      vi.fn().mockRejectedValue(new Error("network blip")),
    );

    const result = await suggestUsdaFoodBatch(usdaService, db, [
      { id: ingredientId, name: "AP flour" },
    ]);

    expect(result).toEqual([
      {
        name: "AP flour",
        food: null,
        confidence: "low",
        reasoning: "Lookup failed.",
      },
    ]);

    expect(mocks.dispatchBackgroundJobs).toHaveBeenCalledTimes(1);
    expect(mocks.dispatchBackgroundJobs).toHaveBeenCalledWith(db, {
      kind: "usda-match.retry",
      source: "mutation",
      jobs: [
        {
          kind: "usda-match.retry",
          dedupeKey: `usda-match.retry:${ingredientId}`,
          payload: { ingredientId },
        },
      ],
    });
  });

  // Load-bearing distinction: a successful lookup that genuinely finds
  // nothing must NOT be conflated with an infra failure, or every unmatched
  // ingredient would silently queue a retry job forever.
  it("dispatches nothing when the lookup succeeds and genuinely finds no match", async () => {
    const ingredientId = unsafeIngredientId(
      "00000000-0000-4000-8000-000000000002",
    );
    const usdaService = fakeUsdaService(
      vi.fn().mockResolvedValue({ data: [], count: 0 }),
    );

    const result = await suggestUsdaFoodBatch(usdaService, db, [
      { id: ingredientId, name: "unobtainium" },
    ]);

    expect(result).toEqual([
      {
        name: "unobtainium",
        food: null,
        confidence: "low",
        reasoning: "No suitable match found.",
      },
    ]);
    expect(mocks.dispatchBackgroundJobs).not.toHaveBeenCalled();
  });

  it("dispatches only for the rejected item in a mixed batch", async () => {
    const okId = unsafeIngredientId("00000000-0000-4000-8000-000000000003");
    const failId = unsafeIngredientId("00000000-0000-4000-8000-000000000004");
    const listFoods = vi
      .fn()
      .mockImplementation((name: string) =>
        name === "flaky ingredient"
          ? Promise.reject(new Error("timeout"))
          : Promise.resolve({ data: [], count: 0 }),
      );
    const usdaService = fakeUsdaService(listFoods);

    await suggestUsdaFoodBatch(usdaService, db, [
      { id: okId, name: "stable ingredient" },
      { id: failId, name: "flaky ingredient" },
    ]);

    expect(mocks.dispatchBackgroundJobs).toHaveBeenCalledTimes(1);
    expect(mocks.dispatchBackgroundJobs).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        jobs: [
          expect.objectContaining({
            payload: { ingredientId: failId },
          }),
        ],
      }),
    );
  });
});

describe("retryUsdaMatch", () => {
  it("re-fetches the ingredient's current name rather than trusting a stale payload", async () => {
    const ingredientId = unsafeIngredientId(
      "00000000-0000-4000-8000-000000000005",
    );
    mocks.getIngredientByID.mockResolvedValue({
      id: ingredientId,
      name: "current name, not the payload's",
    });
    const listFoods = vi.fn().mockResolvedValue({ data: [], count: 0 });
    mocks.buildCrudServices.mockReturnValue({
      usdaService: fakeUsdaService(listFoods),
    });

    await retryUsdaMatch(db, ingredientId);

    expect(mocks.getIngredientByID).toHaveBeenCalledWith(db, ingredientId);
    expect(listFoods).toHaveBeenCalledWith(
      "current name, not the payload's",
      undefined,
      expect.anything(),
      expect.anything(),
    );
  });

  it("lets a real failure throw so processBackgroundJob's backoff takes over", async () => {
    const ingredientId = unsafeIngredientId(
      "00000000-0000-4000-8000-000000000006",
    );
    mocks.getIngredientByID.mockResolvedValue({
      id: ingredientId,
      name: "flour",
    });
    mocks.buildCrudServices.mockReturnValue({
      usdaService: fakeUsdaService(
        vi.fn().mockRejectedValue(new Error("still down")),
      ),
    });

    await expect(retryUsdaMatch(db, ingredientId)).rejects.toThrow(
      "still down",
    );
  });
});
