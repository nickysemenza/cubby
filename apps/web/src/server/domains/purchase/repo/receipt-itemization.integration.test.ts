import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { loadDataQualities } from "~/server/generic/data-quality/repo/hydrate";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import {
  createImageFixture,
  insertEntityAttachments,
} from "~/server/testing/repo.fixtures";

// A member who photographs a store receipt books the charge into a Purchase
// and attaches the photo. That Purchase must reach the Research queue as an
// itemization gap even when its Vendor's policy does not require documents,
// so a Burn-down session reads the receipt and fills in the lines.
describe("receipt Purchase itemization", () => {
  const ctx = withTestDb();

  it.each(["unknown", "not_expected"] as const)(
    "asks for itemization once a receipt is attached (vendor policy %s)",
    async (itemizationExpectation) => {
      const vendor = await insertWithShortcode(ctx.db, "vendor", {
        name: `Receipt shop ${itemizationExpectation}`,
        itemizationExpectation,
      });
      const purchase = await insertWithShortcode(ctx.db, "purchase", {
        vendorId: vendor.id,
        date: "2026-09-01",
      });
      await insertWithShortcode(ctx.db, "expense", {
        lineKind: "principal",
        purchaseId: purchase.id,
        name: "Store visit",
        cost: 42,
        date: "2026-09-01",
        costType: "materials",
        lineBasis: "allocation",
        economicRole: "vendor",
      });
      const gaps = async () =>
        (await loadDataQualities(ctx.db, "purchase", [purchase.id]))
          .get(purchase.id)
          ?.gaps.map((gap) => gap.check);
      expect(await gaps()).not.toContain("purchase_itemization");

      const image = await createImageFixture(
        ctx.db,
        `receipt-${itemizationExpectation}`,
      );
      await insertEntityAttachments(ctx.db, {
        entityId: purchase.id,
        imageId: image.id,
        role: "attachment",
        documentKind: "receipt",
      });
      expect(await gaps()).toContain("purchase_itemization");
    },
  );
});
