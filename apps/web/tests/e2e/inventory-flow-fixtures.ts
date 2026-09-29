import { inventoryCreatePayloadData } from "@cubby/schemas/inventory";
import type { Page } from "@playwright/test";

import { createFixture, seedProductPrerequisite } from "./e2e-fixtures";

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
    stocked?: { locationId: string; quantity: number };
  },
) {
  const product = await seedProductPrerequisite(page, { name: opts.name });
  await createFixture(page, "expense", {
    name: `${opts.name} line`,
    cost: 10,
    date: "2026-01-05",
    costType: "materials",
    trade: "other",
    productId: product.id,
    productQuantity: opts.bought,
  });
  if (opts.stocked) {
    await createFixture(
      page,
      "inventory",
      inventoryCreatePayloadData.parse({
        productId: product.id,
        locationId: opts.stocked.locationId,
        amount: { value: opts.stocked.quantity, unit: "each" },
      }),
    );
  }
  return product;
}
