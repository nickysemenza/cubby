import { resolveProductBrandName } from "~/server/domains/vendor/repo/product-brand";
import type { Page } from "@playwright/test";

import { createFixtureGraph } from "./core";

/**
 * A product the ledger says was bought `bought` times, optionally with stock on
 * one shelf. `bought` against `stocked.quantity` is what puts it in (or out of)
 * the `shelf-disagrees` view; omitting `stocked` leaves it in `unlocated`.
 */
export async function seedLedgerProduct(
  page: Page,
  opts: {
    name: string;
    bought: number;
    /** Line cost; the net basis the triage `minSpend` bound reads. */
    cost?: number;
    categoryId?: string;
    stocked?: { locationId: string; quantity: number };
  },
) {
  return createFixtureGraph(page, async (create, db) => {
    const brandId = await resolveProductBrandName(db, "E2E fixture");
    const product = await create("product", {
      brandId,
      name: opts.name,
      categoryId: opts.categoryId,
    });
    await create("expense", {
      name: `${opts.name} line`,
      cost: opts.cost ?? 10,
      date: "2026-01-05",
      costType: "materials",
      trade: "other",
      productId: product.id,
      productQuantity: opts.bought,
    });
    if (opts.stocked) {
      await create("inventory", {
        productId: product.id,
        locationId: opts.stocked.locationId,
        amount: { value: opts.stocked.quantity, unit: "each" },
      });
    }
    return product;
  });
}
