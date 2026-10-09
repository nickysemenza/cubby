import { dashboardLocalCounts } from "@cubby/schemas/dashboard";
import { fromPartial } from "@total-typescript/shoehorn";
import { withTestDb } from "tooling/test-setup";
import { afterEach, describe, expect, it } from "vitest";

import { setCfEnv } from "~/server/cf-env";
import { getEntityCounts } from "~/server/repo/dashboard";
import {
  createLedgerParty,
  listLedgerParties,
} from "~/server/repo/ledger-party";
import {
  createProductFixture,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { listSpendingCategories } from "~/server/repo/spending-category";

import { getDashboardCounts } from "./dashboard";

describe("dashboard count workflow", () => {
  const ctx = withTestDb();
  afterEach(() => setCfEnv(undefined));

  it("preserves local counts while the USDA release is unavailable", async () => {
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

  it("sums the release's foods per data type beside the local counts", async () => {
    const result = await getDashboardCounts({
      db: ctx.db,
      usdaClient: {
        getCounts: async () => ({
          release: "2000-01",
          foodsByDataType: { branded_food: 20, sr_legacy_food: 22 },
          supersededCount: 5,
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

  it("includes the spending category roster count", async () => {
    await insertWithShortcode(ctx.db, "spendingCategory", {
      name: "Sample category",
    });
    const list = await listSpendingCategories(ctx.db, {}, [], {
      pageIndex: 0,
      pageSize: 1,
    });
    const result = await getDashboardCounts({
      db: ctx.db,
      usdaClient: {
        getCounts: async () => {
          throw new Error("External count unavailable");
        },
      },
    });
    expect(result).toHaveProperty("spendingCategory", list.count);
    expect(list.count).toBeGreaterThan(0);
  });

  it("reads live local counts even when a stale snapshot is available", async () => {
    const snapshot = dashboardLocalCounts.parse({
      ...(await getEntityCounts(ctx.db)),
      product: 17,
    });
    setCfEnv(
      fromPartial<Env>({
        DB_FRESHNESS: {
          getByName: () => ({ getDashboardCounts: async () => snapshot }),
        },
      }),
    );

    const result = await getDashboardCounts({
      db: ctx.db,
      usdaClient: {
        getCounts: async () => ({
          release: "2000-01",
          foodsByDataType: { foundation_food: 42 },
          supersededCount: 0,
        }),
      },
    });
    expect(result.product).toBe(0);
    expect(result.usdaFoods).toBe(42);
  });
});
