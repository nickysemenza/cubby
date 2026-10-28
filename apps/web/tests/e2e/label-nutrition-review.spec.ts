import type { Page } from "@playwright/test";
import { gotoAuthenticatedPage } from "./support/e2e-helpers";
import { createEntityFixture } from "./fixtures/core";
import {
  seedImagePrerequisite,
  attachProductImagePrerequisite,
} from "./fixtures/photos";
import {
  seedDetectedLabelNutrition,
  readStoredLabelNutrition,
} from "./fixtures/label-nutrition";
import { expect, test } from "./support/e2e-test";

async function seedLabelReview(page: Page, objectStorageUrl: string) {
  const name = `E2E label panel ${Date.now()}`;
  // Product/photo creation is covered by photo-group-review.spec.ts.
  const product = await createEntityFixture(page, "product", {
    name,
    labelNutrition: {
      servingGrams: 30,
      nutrients: { kcal: 90, fat: 2 },
      source: "Synthetic prior label",
    },
  });
  const label = await seedImagePrerequisite(
    "synthetic-wardrobe-label",
    objectStorageUrl,
  );
  await attachProductImagePrerequisite(page, label.id, product.id, "label");
  const imageCode = await seedDetectedLabelNutrition(name);
  await gotoAuthenticatedPage(page, `/products/${product.id}`);
  await page.locator("#labels").scrollIntoViewIfNeeded();
  const dialog = page.getByRole("dialog");
  const review = page.getByRole("button", {
    name: "Review detected nutrition",
    exact: true,
  });
  return { name, imageCode, dialog, review };
}

test("detected label nutrition previews inferred values and Cancel preserves current nutrition", async ({
  page,
  e2eRuntime,
}) => {
  const { name, dialog, review } = await seedLabelReview(
    page,
    e2eRuntime.objectStorageUrl,
  );
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
});

test("detected label nutrition stays editable and Save persists the panel evidence", async ({
  page,
  e2eRuntime,
}) => {
  const { name, imageCode, dialog, review } = await seedLabelReview(
    page,
    e2eRuntime.objectStorageUrl,
  );
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
  await page
    .getByRole("heading", { name: "Nutrition summary", exact: true })
    .scrollIntoViewIfNeeded();
  await expect(page.getByText(/inferred zero/).first()).toBeVisible();
  await expect(review).toHaveCount(0);
});
