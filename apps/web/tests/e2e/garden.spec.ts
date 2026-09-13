import { seedIngredientPrerequisite } from "./e2e-fixtures";
import { waitForAppHydration } from "./e2e-helpers";
import { expect, test } from "./e2e-test";

test("a planned garden crop can start and retain a backdated harvest", async ({
  page,
  baseURL,
}) => {
  const suffix = Date.now();
  const bedName = `e2e growing bed ${suffix}`;
  const cropName = `e2e garden crop ${suffix}`;
  await seedIngredientPrerequisite(page, cropName);
  await page.goto("/garden");
  await waitForAppHydration(page);

  await page.getByRole("button", { name: "Add bed or tray" }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name", { exact: true }).fill(bedName);
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const bed = page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: bedName }) });
  await bed.getByRole("button", { name: "Add planting", exact: true }).click();
  dialog = page.getByRole("dialog");
  await dialog
    .getByRole("combobox", { name: "Crop", exact: true })
    .fill(cropName);
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
  const plantingCode = new URL(page.url()).pathname.split("/").at(-1);
  const apiDetail = await page.request.get(`/api/v1/plantings/${plantingCode}`);
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

  await page
    .getByRole("button", { name: "Start planting", exact: true })
    .click();
  dialog = page.getByRole("dialog");
  await dialog
    .getByRole("combobox", { name: "Starting location", exact: true })
    .fill(bedName);
  await page
    .getByRole("option", { name: new RegExp(bedName) })
    .first()
    .click();
  await dialog.getByLabel("Date", { exact: true }).fill("2026-08-01");
  await dialog
    .getByRole("button", { name: "Start planting", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByText("Sowed: 2026-08-01", { exact: true }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Note, photos, or harvest" }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("Entry type").selectOption("harvest");
  await dialog.getByLabel("Observation date").fill("2026-08-20");
  await dialog.getByLabel("Harvest amount (optional)").fill("A handful");
  await dialog.getByLabel("Notes").fill("First harvest from this planting");
  await dialog.getByRole("button", { name: "Save entry", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByText("First harvest from this planting", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("A handful", { exact: true })).toBeVisible();
  await page.reload();
  await expect(
    page.getByText("First harvest from this planting", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Move some seedlings" }),
  ).toBeVisible();
});
