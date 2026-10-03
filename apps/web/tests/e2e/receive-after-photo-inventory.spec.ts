import { eq } from "drizzle-orm";

import { inventoryEntry } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { upsertAgentProductMatch } from "~/server/repo/product-match-candidate";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import {
  gotoAuthenticatedPage,
  selectComboboxItem,
  uniqueName,
} from "./e2e-helpers";
import { expect, test } from "./e2e-test";
import {
  createEntityFixture,
  createEvidenceHarnessContext,
} from "./fixtures-core";
import {
  seedLocationPrerequisite,
  seedProductPrerequisite,
} from "./fixtures-catalog";

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
  const closet = await seedLocationPrerequisite(
    page,
    uniqueName(testInfo, "Synthetic closet"),
  );
  const shelfName = uniqueName(testInfo, "Synthetic receiving shelf");
  await seedLocationPrerequisite(page, shelfName);
  const photo = await seedProductPrerequisite(page, { name: photoName });
  const bought = await seedProductPrerequisite(page, { name: boughtName });
  await createEntityFixture(page, "inventory", {
    productId: photo.id,
    locationId: closet.id,
    amount: { value: 1, unit: "each" },
  });
  const vendor = await insertWithShortcode(db, "vendor", {
    name: uniqueName(testInfo, "Synthetic outfitter"),
  });
  const purchase = await insertWithShortcode(db, "purchase", {
    vendorId: vendor.id,
    date: "2026-09-01",
  });
  const line = await insertWithShortcode(db, "expense", {
    name: uniqueName(testInfo, "Synthetic jacket line"),
    cost: 80,
    date: "2026-09-01",
    costType: "materials",
    purchaseId: purchase.id,
    productId: await resolveOrThrow(db, "product", bought.id),
  });
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
  await gotoAuthenticatedPage(
    page,
    `/expenses/${line.shortcode}`,
    receiveButton,
  );
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

  // The default action writes nothing.
  await dialog.getByRole("button", { name: "Nothing new arrived" }).click();
  await expect(dialog).toHaveCount(0);
  expect(await boughtRows()).toEqual([]);

  // Explicitly confirming additional units still requires a typed quantity.
  await receiveButton.click();
  await dialog
    .getByRole("button", { name: "Additional units arrived" })
    .click();
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

  // The Purchase offers the same dialog per Product line, and the units just
  // received now count as existing stock: the default is again "nothing new".
  await gotoAuthenticatedPage(
    page,
    `/purchases/${purchase.shortcode}`,
    page.getByRole("button", { name: "Receive into inventory..." }),
  );
  await page.getByRole("button", { name: "Receive into inventory..." }).click();
  await expect(
    dialog.getByRole("button", { name: "Nothing new arrived" }),
  ).toBeVisible();
  await expect(dialog.getByText(/already has 2 on hand/)).toBeVisible();
});
