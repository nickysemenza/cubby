import { syntheticCookbookArchive } from "../../tooling/cookbook-bundle-fixture";
import { BROWSER_OPERATION_PATH } from "~/lib/browser-operation-path";
import { dispatchesOperation, unbatchFor } from "./dispatch-wire";
import { expect, test } from "./e2e-test";

test("imports an incomplete cookbook bundle, retries its staged photo, and preserves success on reselection", async ({
  page,
}) => {
  const name = `Synthetic bundle ${Date.now()}`;
  const fixture = syntheticCookbookArchive(name, undefined, true);
  const file = {
    name: "synthetic.cookbook",
    mimeType: "application/octet-stream",
    buffer: fixture.bytes,
  };
  let failPhoto = true;
  await page.route(`**${BROWSER_OPERATION_PATH}`, async (route) => {
    if (await unbatchFor(route, ["recipe.attachCookbookRecipePhoto"])) return;
    if (
      failPhoto &&
      dispatchesOperation(route.request(), "recipe.attachCookbookRecipePhoto")
    ) {
      failPhoto = false;
      await route.abort("failed");
    } else await route.continue();
  });
  await page.goto("/recipes/import");
  const input = page.locator('input[type="file"][accept*=".cookbook"]').first();
  await input.setInputFiles(file);
  await expect(
    page.getByText(
      "This extraction is incomplete. Review the available recipes and the run report before importing.",
      { exact: true },
    ),
  ).toBeVisible();
  await page.getByRole("button", { name: "Import 1", exact: true }).click();
  const imported = page.getByRole("link", { name: "Imported", exact: true });
  await expect(imported).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Retry photo", exact: true }),
  ).toBeVisible();
  const destination = await imported.getAttribute("href");
  if (!destination) throw new Error("Imported recipe has no destination");
  await page.getByRole("button", { name: "Retry photo", exact: true }).click();
  await expect(page.getByText(/^Photo (?:already )?attached$/)).toBeVisible({
    timeout: 30000,
  });
  await input.setInputFiles({ ...file, name: "reselected.cookbook" });
  await expect(imported).toHaveAttribute("href", destination);
  await page.getByRole("button", { name: "Import 1", exact: true }).click();
  await expect(
    page.getByText("Existing photo preserved", { exact: true }),
  ).toBeVisible();
  await expect(imported).toHaveAttribute("href", destination);
  await imported.click();
  const hero = page.getByRole("img", { name: `${name} carrots`, exact: true });
  await expect(hero).toBeVisible();
  await expect
    .poll(() =>
      hero.evaluate((element: HTMLImageElement) => element.naturalWidth),
    )
    .toBeGreaterThan(0);
});
