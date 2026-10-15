import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import { purchase as purchaseTable } from "~/server/db/schema";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

import { getPurchaseByID, updatePurchase } from "./purchase";

const ctx = withTestDb();
it("records an accepted source category through the ordinary Purchase writer", async () => {
  const category = await insertWithShortcode(ctx.db, "spendingCategory", {
    name: "Synthetic supported service purpose",
  });
  const vendor = await insertWithShortcode(ctx.db, "vendor", {
    name: "Synthetic supported service seller",
  });
  const purchase = await insertWithShortcode(ctx.db, "purchase", {
    date: "2026-09-20",
    vendorId: vendor.id,
  });
  const { output } = await updatePurchase(
    ctx.db,
    purchase.shortcode,
    { spendingCategoryId: category.shortcode },
    ctx.actor,
    { spendingCategoryOrigin: "source" },
  );
  expect(output.spendingCategoryOrigin).toBe("source");
  expect(output.spendingCategoryId).toBe(category.shortcode);
});
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
