import {
  seedIngredientPrerequisite,
  seedLocationPrerequisite,
  seedPlantingPrerequisite,
} from "./e2e-fixtures";
import { selectComboboxItem, waitForAppHydration } from "./e2e-helpers";
import { expect, test } from "./e2e-test";

test("a planting's generic pages: create, edit status, log a journal entry, and a location's relation sections", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const suffix = Date.now();
  const cropName = `e2e garden crop ${suffix}`;
  const growingBedName = `e2e growing bed ${suffix}`;
  const emptyShelfName = `e2e empty shelf ${suffix}`;

  const crop = await seedIngredientPrerequisite(page, cropName);
  const growingBed = await seedLocationPrerequisite(page, growingBedName);
  const emptyShelf = await seedLocationPrerequisite(page, emptyShelfName);
  // `hideWhenEmpty` gates the create button along with the rest of the
  // section (`entity-relation-table.tsx`'s `useSectionVisible`), so a
  // location's very first planting can't come from that button — seed one
  // directly and use it to open the section, then create a second one
  // through the real generic dialog.
  const existingPlanting = await seedPlantingPrerequisite(page, {
    ingredientId: crop.id,
    locationId: growingBed.id,
  });

  // Section ids are stable manifest ids (`04-location.entity.ts`); the
  // heading text itself gains a live row count once data loads
  // (`SectionCard`), so the id is the precise handle for "is this section
  // showing at all" rather than its content.
  const plantingsSection = page.locator("#plantings");
  const gardenEntriesSection = page.locator("#garden-entries");

  // A location with no plantings and no garden entries shows neither
  // section — no header, no create button, nothing to indicate they exist.
  // `hideWhenEmpty` hides through the `hidden` attribute rather than an
  // unmount (`detail-page.tsx`), so the section stays in the DOM but is not
  // visible — not merely absent.
  await page.goto(`/locations/${emptyShelf.id}`);
  await waitForAppHydration(page);
  await expect(plantingsSection).not.toBeVisible();
  await expect(gardenEntriesSection).not.toBeVisible();

  // The growing bed already has one planting, so its Plantings section is
  // visible; its Garden entries section is still empty and hidden.
  await page.goto(`/locations/${growingBed.id}`);
  await waitForAppHydration(page);
  await expect(plantingsSection).toBeVisible();
  await expect(gardenEntriesSection).not.toBeVisible();

  // Create a second planting through the section's own generic create
  // dialog — seeded with this location via the direct `locationId` create
  // field (`planRelationSection`'s direct branch).
  await page.getByRole("button", { name: "New planting", exact: true }).click();
  let dialog = page.getByRole("dialog");
  await expect(dialog.getByText("New Planting")).toBeVisible();
  await selectComboboxItem(
    page,
    dialog.getByRole("combobox", { name: "Crop", exact: true }),
    cropName,
  );
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(dialog).not.toBeVisible();

  // Both plantings for this location now show on `/plantings`, the generic
  // entry point (Decision #8 — `/garden` is gone).
  await page.goto(`/plantings?locationId=${growingBed.id}`);
  await waitForAppHydration(page);
  const plantingRows = page.getByRole("link", { name: cropName });
  await expect(plantingRows.first()).toBeVisible();
  await expect(plantingRows).toHaveCount(2);

  // Edit `status` on the seeded planting through the generic edit dialog —
  // it is an ordinary editable field now, not a lifecycle verb.
  await page.goto(`/plantings/${existingPlanting.id}`);
  await waitForAppHydration(page);
  await page
    .getByRole("button", { name: "Edit Planting", exact: true })
    .click();
  dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Edit Planting")).toBeVisible();
  await dialog.getByRole("combobox", { name: "status", exact: true }).click();
  await page.getByRole("option", { name: "Finished", exact: true }).click();
  await dialog
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  const updated = await page.request.get(
    `/api/v1/plantings/${existingPlanting.id}`,
  );
  expect(await updated.json()).toMatchObject({ status: "finished" });

  // The Journal relation section's create button opens the generic garden
  // entry dialog seeded with this planting's id.
  await page.getByRole("button", { name: "Log entry", exact: true }).click();
  dialog = page.getByRole("dialog");
  await expect(dialog.getByText("New Garden Entry")).toBeVisible();
  await selectComboboxItem(
    page,
    dialog.getByRole("combobox", { name: "Location", exact: true }),
    growingBedName,
  );
  await dialog.getByRole("combobox", { name: "kind", exact: true }).click();
  await page.getByRole("option", { name: "Harvest", exact: true }).click();
  await dialog.getByLabel("Observed On", { exact: true }).fill("2026-08-20");
  await dialog.getByLabel("Harvest Amount", { exact: true }).fill("A handful");
  await dialog.getByLabel("Note").fill("First harvest from this planting");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(dialog).not.toBeVisible();

  const journal = page.getByRole("table", { name: "Journal" });
  await expect(journal).toBeVisible();
  await expect(
    journal.getByText("First harvest from this planting", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await waitForAppHydration(page);
  await expect(
    page
      .getByRole("table", { name: "Journal" })
      .getByText("First harvest from this planting", { exact: true }),
  ).toBeVisible();

  // The entry it just logged (`locationId: growingBed`) is a garden entry
  // for the bed too, so the bed's Garden entries section now shows it —
  // `hideWhenEmpty` flips back once its first page is non-empty.
  await page.goto(`/locations/${growingBed.id}`);
  await waitForAppHydration(page);
  await expect(gardenEntriesSection).toBeVisible();
  const gardenEntries = page.getByRole("table", { name: "Garden entries" });
  await expect(gardenEntries).toBeVisible();
  await expect(
    gardenEntries.getByText("First harvest from this planting", {
      exact: true,
    }),
  ).toBeVisible();
});
