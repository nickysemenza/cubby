import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { expect, it } from "vitest";

import { purchase as purchaseTable } from "~/server/db/schema";

import { getDb } from "./database-helpers";
import { getPurchaseByID, updatePurchase } from "./purchase";
import { insertWithShortcode } from "./shortcode-utils";

const ctx = withTestDb();
it("keeps legacy fallback provenance pending review until an explicit category save", async () => {
  const category = await insertWithShortcode(ctx.db, "spendingCategory", {
    name: "Synthetic fallback purpose",
  });
  const vendor = await insertWithShortcode(ctx.db, "vendor", {
    name: "Synthetic fallback vendor",
  });
  const purchase = await insertWithShortcode(ctx.db, "purchase", {
    date: "2026-09-20",
    vendorId: vendor.id,
    spendingCategoryId: category.id,
  });
  const legacy = await getPurchaseByID(ctx.db, purchase.id);
  expect(legacy.spendingCategoryOrigin).toBe("legacy");
  expect(legacy.dataQuality.gaps.map((gap) => gap.check)).toContain(
    "purchase_spending_category_origin",
  );
  const { output: reviewed } = await updatePurchase(
    ctx.db,
    purchase.shortcode,
    { spendingCategoryId: category.shortcode },
    ctx.actor,
  );
  expect(reviewed.spendingCategoryOrigin).toBe("manual");
  expect(reviewed.dataQuality.gaps.map((gap) => gap.check)).not.toContain(
    "purchase_spending_category_origin",
  );
  const stored = await getDb(ctx.db).query.purchase.findFirst({
    where: eq(purchaseTable.id, purchase.id),
  });
  expect(stored?.spendingCategoryId).toBe(category.id);
});
