import { eq } from "drizzle-orm";

import { inventoryEntry } from "~/server/db/schema";
import { getDb } from "~/server/db/helpers";
import { upsertAgentProductMatch } from "~/server/domains/product/repo/match/product-match-candidate";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";

import {
  gotoDetailActions,
  selectComboboxItem,
  uniqueName,
} from "./support/e2e-helpers";
import { expect, test } from "./support/e2e-test";
import {
  createFixtureGraph,
  createEvidenceHarnessContext,
} from "./fixtures/core";

// Failure modes: an imported purchase's Product that is probably the same item
// as photo-counted stock is received blindly (double count); the dialog's
// default writes stock; units are added without a typed quantity.
test("receiving after a photo import writes nothing until additional units are confirmed", async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  const { db } = await createEvidenceHarnessContext(page);
  const photoName = uniqueName(testInfo, "Synthetic photographed jacket");
  const boughtName = uniqueName(testInfo, "Synthetic jacket order line");
  const shelfName = uniqueName(testInfo, "Synthetic receiving shelf");
  const { photo, bought, purchase } = await createFixtureGraph(
    page,
    async (create) => {
      const closet = await create("location", {
        name: uniqueName(testInfo, "Synthetic closet"),
        type: "room",
      });
      await create("location", { name: shelfName, type: "room" });
      const photo = await create("product", { name: photoName });
      const bought = await create("product", { name: boughtName });
      await create("inventory", {
        productId: photo.id,
        locationId: closet.id,
        amount: { value: 1, unit: "each" },
      });
      const vendor = await create("vendor", {
        name: uniqueName(testInfo, "Synthetic outfitter"),
      });
      const purchase = await create("purchase", {
        vendorId: vendor.id,
        date: "2026-09-01",
      });
      await create("expense", {
        lineKind: "principal",
        name: uniqueName(testInfo, "Synthetic jacket line"),
        cost: 80,
        date: "2026-09-01",
        trade: "other",
        costType: "materials",
        purchaseId: purchase.id,
        productId: bought.id,
      });
      return { photo, bought, purchase };
    },
  );
  await upsertAgentProductMatch(db, {
    productIds: [
      await resolveOrThrow(db, "product", bought.id),
      await resolveOrThrow(db, "product", photo.id),
    ],
    evidence: "Synthetic order line matches the photographed jacket",
    sourceUrls: [],
  });
  const boughtUuid = await resolveOrThrow(db, "product", bought.id);
  const boughtRows = () =>
    getDb(db)
      .select()
      .from(inventoryEntry)
      .where(eq(inventoryEntry.productId, boughtUuid))
      .then((rows) => rows.filter((row) => row.deletedAt === null));

  const receiveButton = page.getByRole("button", {
    name: "Receive into inventory...",
  });
  const dialog = page.getByRole("dialog", { name: "Receive into Inventory" });
  await gotoDetailActions(page, `/purchases/${purchase.id}`, receiveButton);
  await receiveButton.click();

  // The photo-counted match comes first, with a link to the directed review.
  await expect(
    dialog.getByText(`This may already be counted as ${photoName}`),
  ).toBeVisible();
  // Other seeded Products can also surface as candidates in a shared
  // database; the photo match's own review link must target this pair.
  await expect(
    dialog
      .getByRole("link", { name: "Review this match" })
      .and(dialog.locator(`a[href*="candidate=${photo.id}"]`)),
  ).toHaveCount(1);
  // No location or quantity controls exist until units are confirmed.
  await expect(dialog.getByRole("combobox", { name: "Location" })).toHaveCount(
    0,
  );

  // Opening the default review state writes nothing. Continue in this dialog
  // instead of closing and refetching the same unchanged receiving context.
  expect(await boughtRows()).toEqual([]);

  // Explicitly confirming additional units still requires a typed quantity.
  await dialog
    .getByRole("button", { name: "Additional units arrived" })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Close Where and how many?" }),
  ).toHaveAttribute("aria-expanded", "true");
  await selectComboboxItem(
    page,
    dialog.getByRole("combobox", { name: "Location" }),
    shelfName,
  );
  await expect(
    dialog.getByRole("button", { name: "Add to inventory" }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Add to inventory" }).click();
  expect(await boughtRows()).toEqual([]);
  await dialog.getByLabel("Amount Value").fill("2");

  await dialog.getByRole("button", { name: "Add to inventory" }).click();
  await expect(dialog).toHaveCount(0);
  const stocked = await boughtRows();
  expect(stocked).toHaveLength(1);
  expect(stocked[0]).toMatchObject({ amountValue: 2, amountUnit: "each" });
});
