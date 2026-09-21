import { seedWardrobePrerequisites } from "./e2e-fixtures";
import { expectViewportBounded, gotoAuthenticatedPage } from "./e2e-helpers";
import { expect, test } from "./e2e-test";

test("wardrobe uses the selected owner's quantity and responds to explicit ownership edits", async ({
  page,
}) => {
  const name = `Wardrobe ${Date.now()}`;
  const { owner, entry } = await seedWardrobePrerequisites(page, name);
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoAuthenticatedPage(
    page,
    `/collections/wardrobe/${owner.id}`,
    page.getByRole("heading", { name: "Wardrobe", exact: true }),
  );
  await expect(
    page.getByRole("link", { name: `${name} shirt`, exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Show 1 current location", exact: true })
    .click();
  await expect(
    page.getByRole("link", { name: `${name} drawer`, exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: `${name} other drawer`, exact: false }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByText("3 each", { exact: true })).toBeVisible();
  await expect(page.getByText("7 each", { exact: true })).toHaveCount(0);
  await expectViewportBounded(page);
  await gotoAuthenticatedPage(
    page,
    `/inventory/${entry.id}`,
    page.getByRole("button", { name: "Save ownership", exact: true }),
  );
  await page
    .getByRole("combobox", { name: "Ownership", exact: true })
    .selectOption("unassigned");
  await page
    .getByRole("button", { name: "Save ownership", exact: true })
    .click();
  await expect(
    page.getByText("Ownership saved", { exact: true }),
  ).toBeVisible();
  await gotoAuthenticatedPage(
    page,
    `/collections/wardrobe/${owner.id}`,
    page.getByRole("heading", { name: "Wardrobe", exact: true }),
  );
  await expect(
    page.getByRole("link", { name: `${name} shirt`, exact: true }),
  ).toHaveCount(0);
});
