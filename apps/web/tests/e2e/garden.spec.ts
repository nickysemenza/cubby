import { z } from "zod";

import {
  seedImagePrerequisite,
  seedIngredientPrerequisite,
  seedLocationPrerequisite,
  seedPlantingPrerequisite,
} from "./e2e-fixtures";
import { selectComboboxItem, waitForAppHydration } from "./e2e-helpers";
import { expect, test } from "./e2e-test";

const createdItemSchema = z.object({ item: z.object({ id: z.string() }) });

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
  const plantingRows = page.locator('a[href^="/plantings/"]', {
    hasText: cropName,
  });
  await expect(plantingRows.first()).toBeVisible();
  await expect(plantingRows).toHaveCount(2);
  await expect(
    page.locator(`a[href="/ingredients/${crop.id}"]`, { hasText: cropName }),
  ).toHaveCount(2);

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
  await page.getByRole("button", { name: "Log entry...", exact: true }).click();
  dialog = page.getByRole("dialog");
  await expect(dialog.getByText("New Garden Entry")).toBeVisible();
  await selectComboboxItem(
    page,
    dialog.getByRole("combobox", { name: "Location", exact: true }),
    growingBedName,
  );
  await dialog.getByRole("combobox", { name: "kind", exact: true }).click();
  await page.getByRole("option", { name: "Harvest", exact: true }).click();
  await dialog.getByLabel("Observed", { exact: true }).fill("2026-08-20");
  await dialog.getByLabel("Harvest amount", { exact: true }).fill("A handful");
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

test("a bought seedling (transplantedOn only, no sowedOn) gets an inferred interval on the plantings Lifecycles timeline", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const suffix = Date.now();
  const cropName = `e2e seedling crop ${suffix}`;
  const bedName = `e2e seedling bed ${suffix}`;
  const crop = await seedIngredientPrerequisite(page, cropName);
  const bed = await seedLocationPrerequisite(page, bedName);
  // `hideWhenEmpty` gates the section's own create button on its first row
  // (see the seeding note atop the first test in this file) — this throwaway
  // planting has neither `sowedOn` nor `transplantedOn`, so the lifecycle
  // computation drops it from the timeline entirely (no start, no markers)
  // and it never becomes a second row to disambiguate from.
  await seedPlantingPrerequisite(page, {
    ingredientId: crop.id,
    locationId: bed.id,
  });

  await page.goto(`/locations/${bed.id}`);
  await waitForAppHydration(page);
  await page.getByRole("button", { name: "New planting", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("New Planting")).toBeVisible();
  await selectComboboxItem(
    page,
    dialog.getByRole("combobox", { name: "Crop", exact: true }),
    cropName,
  );
  // No Sowed fill — only Transplanted, the nursery-bought-plant case decision
  // #1 covers: `lifecycle.start` falls back from `sowedOn` to `transplantedOn`.
  await dialog.getByLabel("Transplanted", { exact: true }).fill("2026-03-01");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(dialog).not.toBeVisible();

  await page.goto(
    `/plantings?locationId=${bed.id}&view=timeline&timelineMode=lifecycles`,
  );
  await waitForAppHydration(page);
  const row = page
    .getByRole("link", { name: cropName, exact: true })
    .locator("xpath=ancestor::div[contains(@class,'grid-cols-[14rem_1fr]')]")
    .first();
  const interval = row.locator("[title]");
  await expect(interval).toHaveCount(1);
  // `confident: false` (the fallback key, not the first, supplied the start)
  // renders as an "Uncertain after <date>" title — the dashed/inferred style
  // the legend calls "Inferred", as opposed to "Confirmed span".
  await expect(interval).toHaveAttribute("title", /^Uncertain after/);
});

test("a planting's list row shows a thumbnail once a journal entry with a photo is logged", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(60_000);
  const suffix = Date.now();
  const cropName = `e2e photo crop ${suffix}`;
  const bedName = `e2e photo bed ${suffix}`;
  const crop = await seedIngredientPrerequisite(page, cropName);
  const bed = await seedLocationPrerequisite(page, bedName);
  const planting = await seedPlantingPrerequisite(page, {
    ingredientId: crop.id,
    locationId: bed.id,
  });

  // Real, servable image bytes for this fixture's key — the planting's list
  // row has no gallery of its own (decision #5); it borrows the latest
  // journal entry's photo through the display-image policy, which needs an
  // actual image to resolve rather than a broken thumbnail.
  const image = await seedImagePrerequisite(`garden-thumb-${suffix}`);
  await page.route(`**/e2e-garden-thumb-${suffix}`, (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#16845b"/></svg>',
    }),
  );

  const created = await page.request.post("/api/v1/garden-entries", {
    headers: { Origin: baseURL! },
    data: {
      locationId: bed.id,
      plantingIds: [planting.id],
      kind: "note",
      observedOn: "2026-03-15",
      note: `${cropName} first photo`,
      pendingImageIds: [image.id],
    },
  });
  expect(created.status(), await created.text()).toBe(201);
  createdItemSchema.parse(await created.json());

  await page.goto(`/plantings?locationId=${bed.id}`);
  await waitForAppHydration(page);
  const plantingLink = page.getByRole("link", { name: cropName, exact: true });
  const row = page.getByRole("row").filter({ has: plantingLink });
  await expect(
    row.getByRole("img", { name: "Image", exact: true }),
  ).toBeVisible();
});
