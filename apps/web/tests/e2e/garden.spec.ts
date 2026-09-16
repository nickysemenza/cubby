import { seedIngredientPrerequisite } from "./e2e-fixtures";
import { waitForAppHydration } from "./e2e-helpers";
import { expect, test } from "./e2e-test";

test("a planned garden crop can start and retain a backdated harvest", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(60_000);
  const browserDiagnostics: string[] = [];
  page.on("pageerror", (error) => {
    browserDiagnostics.push(`[pageerror] ${error.message}`);
  });
  page.on("console", (message) => {
    if (message.type() === "error") {
      browserDiagnostics.push(`[console:error] ${message.text()}`);
    }
  });
  page.on("response", (response) => {
    if (response.status() < 400) return;
    void response
      .text()
      .then((body) => {
        browserDiagnostics.push(
          `[http:${response.status()}] ${response.url()}\n${body.slice(0, 1_500)}`,
        );
      })
      .catch(() => {
        browserDiagnostics.push(
          `[http:${response.status()}] ${response.url()} (response body unavailable)`,
        );
      });
  });
  try {
    const suffix = Date.now();
    const bedName = `e2e growing bed ${suffix}`;
    const cropName = `e2e garden crop ${suffix}`;
    await seedIngredientPrerequisite(page, cropName);

    // `/plantings` is a legacy redirect onto `/garden`, the single landing
    // page for growing areas, plantings, and journal entries.
    await page.goto("/plantings");
    await waitForAppHydration(page);
    await expect(page).toHaveURL(/\/garden$/);

    await page.getByRole("button", { name: "Add growing area" }).click();
    let dialog = page.getByRole("dialog");
    await dialog.getByLabel("Name", { exact: true }).fill(bedName);
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    // Growing-area cards are `Card` (a `div[data-slot="card"]`), not a
    // `<section>`.
    const bed = page
      .locator('[data-slot="card"]')
      .filter({ has: page.getByRole("heading", { name: bedName }) });
    await bed
      .getByRole("button", { name: "Add planting", exact: true })
      .click();
    dialog = page.getByRole("dialog");
    // The picker ignores input while its popup is closed, and its roster
    // is garden-scoped: a fresh crop only appears via the typed search.
    const cropPicker = dialog.getByRole("combobox", {
      name: "Crop",
      exact: true,
    });
    await cropPicker.click();
    await cropPicker.pressSequentially(cropName);
    await page
      .getByRole("option", { name: new RegExp(cropName) })
      .first()
      .click();
    await dialog.getByLabel("Planting state").selectOption("planned");
    await dialog
      .getByRole("button", { name: "Add planting", exact: true })
      .click();
    await expect(dialog).not.toBeVisible();
    await bed.getByRole("link", { name: cropName, exact: true }).click();
    await expect(page).toHaveURL(/\/plantings\/PLT-/);
    // The detail page's tab title is the record's `displayName`.
    await expect(page).toHaveTitle(new RegExp(cropName));
    const plantingCode = new URL(page.url()).pathname.split("/").at(-1);
    const apiDetail = await page.request.get(
      `/api/v1/plantings/${plantingCode}`,
    );
    expect(apiDetail.status()).toBe(200);
    expect(await apiDetail.json()).toMatchObject({
      id: plantingCode,
      status: "planned",
    });
    const corrected = await page.request.patch(
      `/api/v1/plantings/${plantingCode}`,
      {
        headers: { Origin: baseURL! },
        data: { notes: "Corrected through the shared HTTP API" },
      },
    );
    expect(corrected.status()).toBe(200);
    await page.reload();
    // The generic detail renders the declared fields as label/value rows.
    await expect(
      page.getByText("Corrected through the shared HTTP API", { exact: true }),
    ).toBeVisible();
    const guides = await page.request.get("/api/v1/garden/guides");
    expect(guides.status()).toBe(200);
    expect(await guides.json()).toMatchObject({
      schemaVersion: 1,
      sources: expect.arrayContaining([
        expect.objectContaining({ id: "uc-sunny" }),
        expect.objectContaining({ id: "uc-foggy" }),
      ]),
    });

    // Lifecycle verbs are registry actions in the detail command strip; the
    // trailing ellipsis marks a verb that opens a dialog.
    await page
      .getByRole("button", { name: "Start planting...", exact: true })
      .click();
    dialog = page.getByRole("dialog");
    const locationPicker = dialog.getByRole("combobox", {
      name: "Location",
      exact: true,
    });
    await locationPicker.click();
    await locationPicker.pressSequentially(bedName);
    await page
      .getByRole("option", { name: new RegExp(bedName) })
      .first()
      .click();
    await dialog.getByLabel("Date", { exact: true }).fill("2026-08-01");
    await dialog
      .getByRole("button", { name: "Start planting", exact: true })
      .click();
    await expect(dialog).not.toBeVisible();
    // The "Sowed On" fact renders through the shared date formatter.
    await expect(page.getByText("Aug 1, 2026", { exact: true })).toBeVisible();

    // The journal relation section's create button opens the generic garden
    // entry dialog prefilled with this planting.
    await page.getByRole("button", { name: "Log entry", exact: true }).click();
    dialog = page.getByRole("dialog");
    const entryLocation = dialog.getByRole("combobox", {
      name: "Location Id",
      exact: true,
    });
    await entryLocation.click();
    await entryLocation.pressSequentially(bedName);
    await page
      .getByRole("option", { name: new RegExp(bedName) })
      .first()
      .click();
    const kindPicker = dialog.getByRole("combobox", {
      name: "Kind",
      exact: true,
    });
    await kindPicker.click();
    await page.getByRole("option", { name: "Harvest" }).first().click();
    await dialog.getByLabel("Observed On", { exact: true }).fill("2026-08-20");
    await dialog
      .getByLabel("Harvest Amount", { exact: true })
      .fill("A handful");
    await dialog.getByLabel("Note").fill("First harvest from this planting");
    await dialog.getByRole("button", { name: "Create", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    // The journal is the garden-entry list scoped to this planting.
    const journal = page.getByRole("table", { name: "Journal" });
    await expect(journal).toBeVisible();
    await expect(
      journal.getByText("First harvest from this planting", { exact: true }),
    ).toBeVisible();
    await expect(journal.getByText("A handful", { exact: true })).toBeVisible();
    await page.reload();
    await expect(
      page.getByText("First harvest from this planting", { exact: true }),
    ).toBeVisible();
    // The remaining lifecycle verbs sit behind the command strip's overflow.
    await page.getByRole("button", { name: "More actions" }).click();
    await expect(
      page.getByRole("menuitem", { name: "Move some seedlings..." }),
    ).toBeVisible();
    await page.keyboard.press("Escape");

    const plantingUrl = page.url();
    const currentPlanting = await page.request.get(
      `/api/v1/plantings/${plantingCode}`,
    );
    const { locationId } = await currentPlanting.json();
    // A whole-area entry (no planting) is recorded through the API; the
    // list has no create trigger of its own.
    const areaEntry = await page.request.post("/api/v1/garden/recordEntry", {
      headers: { Origin: baseURL! },
      data: {
        locationId,
        plantingId: null,
        observedOn: "2026-08-12",
        kind: "observation",
        note: "Another shared bed observation",
        pendingImageIds: [],
      },
    });
    expect(areaEntry.status()).toBe(200);
    // The bed journal is the generic garden-entry list scoped by `locationId`:
    // the planting's harvest entry and the whole-area entry are both rows.
    await page.goto(`/garden-entries?locationId=${locationId}`);
    await waitForAppHydration(page);
    await expect(
      page.getByRole("table", { name: "Garden entries table" }),
    ).toBeVisible();
    await expect(
      page.getByText("First harvest from this planting", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Another shared bed observation", { exact: true }),
    ).toBeVisible();
    // The planting's own journal is scoped to its entries alone.
    await page.goto(plantingUrl);
    await waitForAppHydration(page);
    await expect(
      page.getByText("Another shared bed observation", { exact: true }),
    ).not.toBeVisible();
    // Location dates are confirmed from the Location history section.
    await page
      .getByRole("button", { name: "Confirm location dates", exact: true })
      .click();
    dialog = page.getByRole("dialog");
    await dialog.getByLabel("In this location since").fill("2026-07-01");
    await dialog.getByRole("button", { name: "Save location dates" }).click();
    await expect(dialog).not.toBeVisible();
    await expect(
      page.getByText("Correct location dates", { exact: true }),
    ).toBeVisible();
  } finally {
    await test.info().attach("browser-diagnostics.txt", {
      body:
        browserDiagnostics.join("\n\n") || "No browser diagnostics captured.",
      contentType: "text/plain",
    });
  }
});
