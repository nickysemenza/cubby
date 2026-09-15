import {
  seedImagePrerequisite,
  seedIngredientPrerequisite,
} from "./e2e-fixtures";
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
    // Facts (crop, dates, notes) render directly now — no collapsed
    // "Dates, source, and planting actions" details to expand first.
    await expect(
      page.getByText("Notes: Corrected through the shared HTTP API", {
        exact: true,
      }),
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

    await page
      .getByRole("button", { name: "Start planting", exact: true })
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
    // Facts render "Sowed: <formatted date>" via `formatDateWithYear`.
    await expect(
      page.getByText("Sowed: Aug 1, 2026", { exact: true }),
    ).toBeVisible();

    // The detail page's primary action is "Log entry" now that the planting
    // is growing with a location (was "Add photos / Log entry").
    await page.getByRole("button", { name: "Log entry", exact: true }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByLabel("Entry type").selectOption("harvest");
    // The date field relabels to "Harvest date" once Harvest is selected.
    await dialog.getByLabel("Harvest date", { exact: true }).fill("2026-08-20");
    await dialog
      .getByLabel("Harvest amount", { exact: true })
      .fill("A handful");
    await dialog.getByLabel("Notes").fill("First harvest from this planting");
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(
      page.getByText("First harvest from this planting", { exact: true }),
    ).toBeVisible();
    // Harvest amount renders inline as "Harvest: <amount>".
    await expect(
      page.getByText("Harvest: A handful", { exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(
      page.getByText("First harvest from this planting", { exact: true }),
    ).toBeVisible();
    // "Move some seedlings" now lives inside the "Actions" dropdown.
    await page.getByRole("button", { name: "Open planting actions" }).click();
    await expect(
      page.getByRole("menuitem", { name: "Move some seedlings" }),
    ).toBeVisible();
    await page.keyboard.press("Escape");

    const plantingUrl = page.url();
    const currentPlanting = await page.request.get(
      `/api/v1/plantings/${plantingCode}`,
    );
    const { locationId } = await currentPlanting.json();
    const imageName = `journal-${suffix}`;
    const image = await seedImagePrerequisite(imageName);
    // Image hosting is external to the Worker/SQL harness; use a synthetic scene,
    // while the entry, typed attachment, and journal queries use the real backend.
    await page.route(
      (url) => url.href.includes(`e2e-${imageName}`),
      (route) =>
        route.fulfill({
          contentType: "image/svg+xml",
          body: '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="640" height="480" fill="#dce8d5"/><rect x="45" y="230" width="250" height="190" fill="#89745f"/><rect x="345" y="150" width="250" height="270" fill="#617957"/><text x="35" y="65" font-size="32" fill="#243522">Synthetic bed observation</text></svg>',
        }),
    );
    const bedEntry = await page.request.post("/api/v1/garden/recordEntry", {
      headers: { Origin: baseURL! },
      data: {
        locationId,
        plantingId: null,
        observedOn: "2026-08-10",
        kind: "observation",
        note: "A view of the whole bed",
        pendingImageIds: [image.id],
      },
    });
    expect(bedEntry.status()).toBe(200);
    await page.goto(plantingUrl);
    await expect(
      page.getByText("A view of the whole bed", { exact: true }),
    ).toBeVisible();
    // Photo accessible names are "<Kind> photo, <date>", not the filename —
    // and the journal photo strip now duplicates every entry's images
    // alongside the entry's own grid, so scope to the first match.
    const bedPhotoName = "Note photo, Aug 10, 2026";
    await expect(
      page.getByRole("img", { name: bedPhotoName }).first(),
    ).toBeVisible();
    await page
      .getByRole("button", { name: `View ${bedPhotoName}` })
      .first()
      .click();
    await expect(
      page.getByRole("link", { name: "View image details" }),
    ).toHaveAttribute("href", `/images/${image.id}`);
    const viewer = page.getByRole("dialog");
    await viewer.getByRole("button", { name: "Close", exact: true }).click();
    await expect(viewer).not.toBeVisible();
    await page.evaluate(() => {
      window.scrollTo(0, 0);
      if (document.activeElement instanceof HTMLElement)
        document.activeElement.blur();
    });
    await page.screenshot({ path: "/tmp/cubby-garden-journal-desktop.png" });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(
      page.getByRole("img", { name: bedPhotoName }).first(),
    ).toBeVisible();
    await page.evaluate(() => {
      window.scrollTo(0, 0);
      if (document.activeElement instanceof HTMLElement)
        document.activeElement.blur();
    });
    await page.screenshot({ path: "/tmp/cubby-garden-journal-phone.png" });
    // The bed journal link's text is now `${location name} journal`.
    await page
      .getByRole("link", { name: `${bedName} journal`, exact: true })
      .click();
    await expect(page).toHaveURL(/garden-entries\?locationId=/);
    await expect(
      page.getByRole("link", { name: "Garden", exact: true }),
    ).toBeVisible();
    await expect(page.getByText("Loading history…")).not.toBeVisible();
    await page.getByRole("button", { name: "Log entry", exact: true }).click();
    dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("combobox", { name: "About" })).toHaveValue(
      "Whole area",
    );
    await dialog.getByLabel("Date", { exact: true }).fill("2026-08-12");
    await dialog.getByLabel("Notes").fill("Another shared bed observation");
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await page.goto(plantingUrl);
    await expect(
      page.getByText("Another shared bed observation", { exact: true }),
    ).toBeVisible();
    const earlierEntry = await page.request.post("/api/v1/garden/recordEntry", {
      headers: { Origin: baseURL! },
      data: {
        locationId,
        plantingId: null,
        observedOn: "2026-07-15",
        kind: "observation",
        note: "Older bed context awaiting a confirmed date",
        pendingImageIds: [],
      },
    });
    expect(earlierEntry.status()).toBe(200);
    await page.reload();
    await waitForAppHydration(page);
    await expect(
      page.getByText("Older bed context awaiting a confirmed date", {
        exact: true,
      }),
    ).not.toBeVisible();
    // "Correct location dates" now lives inside the "Actions" dropdown.
    await page.getByRole("button", { name: "Open planting actions" }).click();
    await page
      .getByRole("menuitem", { name: "Correct location dates" })
      .click();
    dialog = page.getByRole("dialog");
    await dialog.getByLabel("In this location since").fill("2026-07-01");
    await dialog.getByRole("button", { name: "Save location dates" }).click();
    await expect(dialog).not.toBeVisible();
    await expect(
      page.getByText("Older bed context awaiting a confirmed date", {
        exact: true,
      }),
    ).toBeVisible();
  } finally {
    await test.info().attach("browser-diagnostics.txt", {
      body:
        browserDiagnostics.join("\n\n") || "No browser diagnostics captured.",
      contentType: "text/plain",
    });
  }
});
