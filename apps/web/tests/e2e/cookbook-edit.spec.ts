import {
  seedCookbookSourcePrerequisite,
  seedStaplePlanningPrerequisite,
} from "./fixtures/recipes";
import {
  gotoAuthenticatedPage,
  openDetailActions,
  uniqueName,
  selectComboboxItem,
} from "./support/e2e-helpers";
import { expect, test } from "./support/e2e-test";

test("a cookbook is retitled from its page and a recipe is re-pointed to it from the recipe editor", async ({
  page,
}, testInfo) => {
  const name = uniqueName(testInfo, "Cookbook edit");
  const book = await seedCookbookSourcePrerequisite(page, `${name} book`);
  const other = await seedCookbookSourcePrerequisite(page, `${name} other`);
  const { recipe } = await seedStaplePlanningPrerequisite(page, name);

  // Retitle: the detail heading follows the saved title.
  const retitled = `${name} retitled`;
  await gotoAuthenticatedPage(page, `/cookbooks/${book.id}`);
  await openDetailActions(page);
  const actions = page.getByRole("group", {
    name: "Entity actions",
    exact: true,
  });
  await expect(
    actions.getByRole("button", { name: "Reprocess", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Edit Cookbook" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit cookbook" });
  await dialog.getByLabel("Title").fill(retitled);
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByRole("heading", { name: retitled, exact: true }),
  ).toBeVisible();

  // A title another cookbook holds is refused with the holder named.
  await page.getByRole("button", { name: "Edit Cookbook" }).click();
  await dialog.getByLabel("Title").fill(`${name} other`);
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(dialog.getByRole("alert")).toContainText(/already used by/);
  await dialog.getByRole("button", { name: "Cancel" }).click();

  // Re-point: pick the other cookbook in the recipe editor; the recipe's
  // source now links to it.
  await gotoAuthenticatedPage(page, `/recipes/${recipe.id}?edit=true`);
  await selectComboboxItem(
    page,
    page.getByRole("combobox", { name: "Cookbook (Optional)" }),
    `${name} other`,
  );
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page.getByRole("link", { name: `${name} other`, exact: true }).first(),
  ).toHaveAttribute("href", new RegExp(`/cookbooks/${other.id}`));
});
