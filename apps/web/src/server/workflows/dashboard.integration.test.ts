import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getEntityCounts } from "~/server/repo/dashboard";
import {
  createLedgerParty,
  listLedgerParties,
} from "~/server/repo/ledger-party";
import {
  createProductFixture,
  makeProductInput,
} from "~/server/repo/repo.fixtures";

import { getDashboardCounts } from "./dashboard";

describe("dashboard count workflow", () => {
  const ctx = withTestDb();

  it("preserves local counts when the external USDA service fails", async () => {
    await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Dashboard test product" }),
      ctx.actor,
    );
    const result = await getDashboardCounts({
      db: ctx.db,
      usdaClient: {
        getCounts: async () => {
          throw new Error("External count unavailable");
        },
      },
    });
    expect(result.product).toBe(1);
    expect(result.usdaFoods).toBe(0);
    expect(result.usdaFoodsAvailable).toBe(false);
    expect(result.device).toBe(0);
  });

  it("combines external counts with the local entity population", async () => {
    const result = await getDashboardCounts({
      db: ctx.db,
      usdaClient: {
        getCounts: async () => ({
          usda_food: 42,
          usda_branded_food: 20,
          usda_nutrient: 10,
          usda_food_nutrient: 50,
          usda_measure_unit: 3,
          usda_food_portion: 4,
          usda_sr_legacy_food: 22,
        }),
      },
    });
    expect(result.product).toBe(0);
    expect(result.usdaFoods).toBe(42);
    expect(result.usdaFoodsAvailable).toBe(true);
  });

  it("matches the unfiltered live roster for an optional local count", async () => {
    await createLedgerParty(
      ctx.db,
      { name: "Sample household member", kind: "member", notes: null },
      ctx.actor,
    );
    const list = await listLedgerParties(ctx.db, {}, [], {
      pageIndex: 0,
      pageSize: 1,
    });
    const result = await getEntityCounts(ctx.db);
    expect(result.ledgerParty).toBe(list.count);
  });
});
