import { fileURLToPath } from "node:url";
import {
  gotoAuthenticatedPage,
  openProductFromPalette,
  waitForFormHydration,
  waitForAppHydration,
} from "./e2e-helpers";
import {
  seedDetectedLabelNutrition,
  readStoredLabelNutrition,
} from "./fixtures-label-nutrition";
import { expect, test } from "./e2e-test";

const labelPhoto = fileURLToPath(
  new URL("./fixtures/synthetic-wardrobe-label.png", import.meta.url),
);

test("detected label nutrition stays editable and requires Save before replacing Product nutrition", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const name = `E2E label panel ${Date.now()}`;
  await gotoAuthenticatedPage(page, "/products?create=true");
  await waitForFormHydration(page);
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Name", exact: true }).fill(name);
  await dialog.getByRole("heading", { name: "Nutrition", exact: true }).click();
  await dialog.getByText(/^Package label/).click();
  await dialog.getByLabel("Serving size, as printed (g)").fill("30");
  await dialog.getByLabel("Calories (kcal)", { exact: true }).fill("90");
  await dialog.getByLabel("Total Fat (g)", { exact: true }).fill("2");
  await dialog
    .getByLabel("Source", { exact: true })
    .fill("Synthetic prior label");
  await dialog.getByLabel("Attach as").selectOption("label");
  await dialog.getByLabel("Choose image").setInputFiles(labelPhoto);
  await expect(
    dialog.getByRole("button", { name: "Remove synthetic-wardrobe-label.png" }),
  ).toBeVisible();
  await expect(dialog.getByText("Uploading...", { exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByText("Photo added.", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: /^Create$/ }).click();
  await expect(dialog).not.toBeVisible();
  await openProductFromPalette(page, name);
  const imageCode = await seedDetectedLabelNutrition(page, name);
  await page.reload();
  await waitForAppHydration(page);
  const review = page.getByRole("button", {
    name: "Review detected nutrition",
    exact: true,
  });
  await review.click();
  await expect(
    dialog.getByRole("img", { name: "Source nutrition panel" }),
  ).toBeVisible();
  await dialog
    .getByText("Current nutrition · 30 g per serving", { exact: true })
    .click();
  const fatComparison = dialog.getByRole("row").filter({
    has: page.getByRole("cell", { name: "Total Fat", exact: true }),
  });
  await expect(
    fatComparison.getByRole("cell", { name: "2", exact: true }),
  ).toBeVisible();
  await expect(
    fatComparison.getByRole("cell", { name: /0 \(inferred\)/ }),
  ).toBeVisible();
  await dialog.getByRole("heading", { name: "Nutrition", exact: true }).click();
  await expect(dialog.getByLabel("Serving size, as printed (g)")).toHaveValue(
    "40",
  );
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(await readStoredLabelNutrition(name)).toMatchObject({
    servingGrams: 30,
    nutrients: { kcal: 90, fat: 2 },
    source: "Synthetic prior label",
  });
  await review.click();
  await dialog.getByRole("heading", { name: "Nutrition", exact: true }).click();
  await dialog.getByLabel("Serving size, as printed (g)").fill("45");
  await dialog
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  const saved = await readStoredLabelNutrition(name);
  expect(saved?.servingGrams).toBe(45);
  expect(saved?.nutrients).toEqual({ kcal: 120, protein: 4, sodium: 0 });
  expect(saved?.source).toContain(imageCode);
  expect(saved?.inferredZeroNutrients).toEqual(["fat"]);
  expect(saved?.inferenceEvidence).toBe(
    "Not a significant source of total fat.",
  );
  await page.getByRole("button", { name: "More details", exact: true }).click();
  await expect(page.getByText(/inferred zero/).first()).toBeVisible();
  await page.reload();
  await expect(review).toHaveCount(0);
});
