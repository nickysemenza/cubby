import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { vendor as vendorTable } from "~/server/db/schema";

import { getDb } from "./database-helpers";
import { insertWithShortcode } from "./shortcode-utils";
import { loadVendorSuggestionContext } from "./vendor-suggestion-context";

// A vendor's own fallback must not masquerade as independent purchase evidence;
// changing its reviewed defaults must invalidate the proposal.
describe("vendor suggestion evidence", () => {
  const ctx = withTestDb();
  it("separates defaults from independent evidence and fingerprints changes", async () => {
    const category = await insertWithShortcode(ctx.db, "spendingCategory", {
      name: "Fixture groceries",
    });
    const merchant = await insertWithShortcode(ctx.db, "vendor", {
      name: "Fixture market",
      spendingProfile: "food_retail",
      defaultSpendingCategoryId: category.id,
    });
    const order = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: merchant.id,
      date: "2026-09-01",
    });
    await insertWithShortcode(ctx.db, "expense", {
      name: "Fixture goods",
      cost: 12,
      date: "2026-09-01",
      purchaseId: order.id,
      costType: "materials",
      trade: "other",
    });
    const before = await loadVendorSuggestionContext(
      ctx.db,
      merchant.shortcode,
    );
    expect(before.lines[0]).toMatchObject({
      explicitSpendingCategory: null,
      productCategory: null,
    });
    expect(before.subject).not.toContain(
      '"effectiveSpendingCategory":"Fixture groceries"',
    );
    await getDb(ctx.db)
      .update(vendorTable)
      .set({ spendingProfile: "mixed_retail" })
      .where(eq(vendorTable.id, merchant.id));
    const after = await loadVendorSuggestionContext(ctx.db, merchant.shortcode);
    expect(after.fingerprint).not.toBe(before.fingerprint);
  });
});
