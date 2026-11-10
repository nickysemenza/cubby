import type { Page } from "@playwright/test";

import { createFixtureGraph } from "./fixtures/core";
import {
  selectComboboxItem,
  gotoAuthenticatedPage,
} from "./support/e2e-helpers";
import { expect, test } from "./support/e2e-test";

async function seedGarden(page: Page) {
  const suffix = Date.now();
  const cropName = `e2e garden crop ${suffix}`;
  const growingBedName = `e2e growing bed ${suffix}`;
  const { crop, growingBed, existingPlanting } = await createFixtureGraph(
    page,
    async (create) => {
      const crop = await create("plant", { name: cropName });
      const growingBed = await create("location", {
        name: growingBedName,
        type: "room",
        parentId: null,
      });
      const existingPlanting = await create("planting", {
        plantId: crop.id,
        locationId: growingBed.id,
      });
      return { crop, growingBed, existingPlanting };
    },
  );

  return {
    cropName,
    growingBedName,
    crop,
    growingBed,
    existingPlanting,
  };
}

test("location relation sections create a planting and list both plantings", async ({
  page,
}) => {
  const { crop, cropName, growingBed } = await seedGarden(page);
  // Section ids are stable manifest ids (`04-location.entity.ts`); the
  // heading text itself gains a live row count once data loads
  // (`SectionCard`), so the id is the precise handle for "is this section
  // showing at all" rather than its content.
  const plantingsSection = page.locator("#plantings");
  const gardenEntriesSection = page.locator("#garden-entries");

  await gotoAuthenticatedPage(page, `/locations/${growingBed.id}#work`);
  await expect(plantingsSection).toBeVisible();
  // A relation known to be empty folds into the "Nothing recorded" line.
  await page
    .getByRole("button", { name: "Show Garden entries, nothing recorded" })
    .click();
  await expect(gardenEntriesSection).toBeVisible();
  await expect(
    gardenEntriesSection.getByText("0", { exact: true }),
  ).toBeVisible();

  // Create a second planting through the section's own generic create
  // dialog — seeded with this location via the direct `locationId` create
  // field (`planRelationSection`'s direct branch).
  await page.getByRole("button", { name: "New planting", exact: true }).click();
  let dialog = page.getByRole("dialog");
  await expect(dialog.getByText("New Planting")).toBeVisible();
  await selectComboboxItem(
    page,
    dialog.getByRole("combobox", { name: "Plant", exact: true }),
    cropName,
  );
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(dialog).not.toBeVisible();

  // Both plantings for this location now show on `/plantings`, the generic
  // entry point (Decision #8 — `/garden` is gone).
  await gotoAuthenticatedPage(page, `/plantings?locationId=${growingBed.id}`);
  const plantingRows = page.locator('a[href^="/plantings/"]', {
    hasText: cropName,
  });
  await expect(plantingRows.first()).toBeVisible();
  await expect(plantingRows).toHaveCount(2);
  await expect(
    page.locator(`a[href="/plants/${crop.id}"]`, { hasText: cropName }),
  ).toHaveCount(2);
});

test("a planting journal entry persists and appears in its location relation", async ({
  page,
}) => {
  const { growingBedName, growingBed, existingPlanting } =
    await seedGarden(page);
  const gardenEntriesSection = page.locator("#garden-entries");
  await gotoAuthenticatedPage(page, `/plantings/${existingPlanting.id}`);
  // The Journal relation section's create button opens the generic garden
  // entry dialog seeded with this planting's id.
  await page
    .getByRole("button", { name: "Show Journal, nothing recorded" })
    .click();
  await page.getByRole("button", { name: "Log entry...", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("New Garden Entry")).toBeVisible();
  await selectComboboxItem(
    page,
    dialog.getByRole("combobox", { name: "Location", exact: true }),
    growingBedName,
  );
  await dialog.getByRole("combobox", { name: "Kind", exact: true }).click();
  await page.getByRole("option", { name: "Harvest", exact: true }).click();
  await dialog.getByLabel("Observed on", { exact: true }).fill("2026-08-20");
  await dialog.getByLabel("Harvest amount", { exact: true }).fill("A handful");
  await dialog.getByLabel("Note").fill("First harvest from this planting");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(dialog).not.toBeVisible();

  const journal = page.getByRole("table", { name: "Journal" });
  await expect(journal).toBeVisible();
  await expect(
    journal.getByText("First harvest from this planting", { exact: true }),
  ).toBeVisible();
  // The entry it just logged (`locationId: growingBed`) is a garden entry
  // for the bed too, so its Garden entries section now shows the entry.
  await gotoAuthenticatedPage(page, `/locations/${growingBed.id}#work`);
  await expect(gardenEntriesSection).toBeVisible();
  const gardenEntries = page.getByRole("table", { name: "Garden entries" });
  await expect(gardenEntries).toBeVisible();
  await expect(
    gardenEntries.getByText("First harvest from this planting", {
      exact: true,
    }),
  ).toBeVisible();
});
