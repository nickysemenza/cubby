import { fileURLToPath } from "node:url";
import { seedCookbookSourcePrerequisite } from "./e2e-fixtures";
import { expect, test } from "./e2e-test";

const epubPath = fileURLToPath(
  new URL("./fixtures/recipe-photos.epub", import.meta.url),
);

test("retries a selected recipe photo from the original EPUB and preserves it on re-import", async ({
  page,
}) => {
  const bookName = `Photo cookbook ${Date.now()}`;
  const recipeName = `${bookName} carrots`;
  // Text extraction is a persisted prerequisite. This contract exercises real
  // archive bytes, WASM, browser transport, PostgreSQL and the external S3 seam.
  const cookbook = await seedCookbookSourcePrerequisite(page, bookName);
  const importUrl = `/recipes/import?from=${cookbook.id}`;
  await page.goto(importUrl);
  await page
    .getByRole("checkbox", { name: `Select ${recipeName}`, exact: true })
    .check();
  await page.getByRole("button", { name: "Import 1", exact: true }).click();
  await expect(
    page.getByText("Choose the original EPUB to add this photo.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Imported", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Import 1", exact: true }),
  ).toBeEnabled();
  await page
    .getByLabel(`Original EPUB for ${bookName}`)
    .setInputFiles(epubPath);
  await page.getByRole("button", { name: "Retry photo", exact: true }).click();
  await expect(page.getByText(/^Photo (?:already )?attached$/)).toBeVisible({
    timeout: 30000,
  });
  await expect(
    page.getByRole("button", { name: "Import 1", exact: true }),
  ).toBeEnabled();
  const recipeLink = page.getByRole("link", { name: "Imported", exact: true });
  const recipeUrl = await recipeLink.getAttribute("href");
  if (!recipeUrl)
    throw new Error("Imported recipe link is missing its destination");
  await recipeLink.click();
  const hero = page.getByRole("img", { name: recipeName, exact: true });
  await expect(hero).toBeVisible();
  await expect
    .poll(() =>
      hero.evaluate((element: HTMLImageElement) => element.naturalWidth),
    )
    .toBeGreaterThan(0);
  const firstImage = await hero.getAttribute("src");

  await page.goto(importUrl);
  await page
    .getByRole("checkbox", { name: `Select ${recipeName}`, exact: true })
    .check();
  await page.getByRole("button", { name: "Import 1", exact: true }).click();
  // Reopened source has no EPUB bytes. Recipe text still imports successfully;
  // an existing persisted photo remains available without another upload.
  await expect(
    page.getByRole("link", { name: "Imported", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Import 1", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByText("Existing photo preserved", { exact: true }),
  ).toBeVisible();
  await page.goto(recipeUrl);
  await expect(
    page.getByRole("img", { name: recipeName, exact: true }),
  ).toHaveAttribute("src", firstImage ?? "");
});
