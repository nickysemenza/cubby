import {
  attachProductImagePrerequisite,
  seedImagePrerequisite,
  seedProductCategoryPrerequisite,
} from "./e2e-fixtures";
import {
  expectViewportBounded,
  gotoAuthenticatedPage,
  openProductFromPalette,
  selectComboboxItem,
  waitForFormHydration,
} from "./e2e-helpers";
import { expect, test } from "./e2e-test";

test("taxonomy edits keep product classification paths and labels separate from covers", async ({
  page,
}) => {
  const suffix = Date.now();
  const originalRoot = `Wardrobe taxonomy root ${suffix}`;
  const destinationRoot = `Wardrobe taxonomy destination ${suffix}`;
  const originalType = `Wardrobe taxonomy type ${suffix}`;
  const renamedType = `Wardrobe taxonomy renamed ${suffix}`;
  const productName = `Wardrobe classified product ${suffix}`;
  const original = await seedProductCategoryPrerequisite(page, {
    name: originalRoot,
  });
  await seedProductCategoryPrerequisite(page, {
    name: destinationRoot,
  });
  const type = await seedProductCategoryPrerequisite(page, {
    name: originalType,
    parentId: original.id,
  });

  await gotoAuthenticatedPage(
    page,
    `/product-categories/${type.id}`,
    page.getByRole("heading", { level: 1, name: originalType }),
  );
  await page
    .getByRole("button", { name: "Edit Product Category", exact: true })
    .click();
  const editor = page.getByRole("dialog");
  await editor
    .getByRole("textbox", { name: "Name", exact: true })
    .fill(renamedType);
  await selectComboboxItem(
    page,
    editor.getByRole("combobox", { name: "Parent category", exact: true }),
    destinationRoot,
  );
  await editor
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(editor).not.toBeVisible({ timeout: 15_000 });
  await expect(
    page.getByRole("heading", { level: 1, name: renamedType }),
  ).toBeVisible();

  await page.goto("/products?create=true");
  await waitForFormHydration(page);
  const createDialog = page.getByRole("dialog");
  await createDialog
    .getByRole("textbox", { name: "Name", exact: true })
    .fill(productName);
  await selectComboboxItem(
    page,
    createDialog.getByRole("combobox", { name: "Classification", exact: true }),
    `${destinationRoot} / ${renamedType}`,
  );
  await createDialog.getByRole("button", { name: /^Create$/ }).click();
  await expect(createDialog).not.toBeVisible({ timeout: 15_000 });
  await openProductFromPalette(page, productName);
  await expect(
    page.getByText(`${destinationRoot} / ${renamedType}`, { exact: true }),
  ).toBeVisible();

  const productId = new URL(page.url()).pathname.split("/").at(-1)!;
  const itemImageName = `wardrobe-item-${suffix}`;
  const labelImageName = `wardrobe-label-${suffix}`;
  const [itemImage, labelImage] = await Promise.all([
    seedImagePrerequisite(itemImageName),
    seedImagePrerequisite(labelImageName),
  ]);
  await Promise.all([
    attachProductImagePrerequisite(page, itemImage.id, productId, "item"),
    attachProductImagePrerequisite(page, labelImage.id, productId, "label"),
  ]);
  await page.route(`**/e2e-${itemImageName}`, (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"/>',
    }),
  );
  await page.route(`**/e2e-${labelImageName}`, (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"/>',
    }),
  );
  await gotoAuthenticatedPage(
    page,
    `/products/${productId}`,
    page.getByRole("heading", { level: 1, name: productName }),
  );
  await expect(
    page.locator("#images").getByRole("img", { name: `${itemImageName}.png` }),
  ).toBeVisible();
  await expect(
    page.locator("#images").getByRole("img", { name: `${labelImageName}.png` }),
  ).toHaveCount(0);
  await expect(
    page
      .getByTestId("detail-rail-media")
      .getByRole("img", { name: `${labelImageName}.png` }),
  ).toHaveCount(0);
  const labels = page.locator("#labels");
  await expect(
    labels.getByRole("img", { name: `${labelImageName}.png` }),
  ).toBeVisible();
  await expect(
    labels.getByRole("img", { name: `${itemImageName}.png` }),
  ).toHaveCount(0);
  await page.screenshot({
    path: test.info().outputPath("product-images-desktop.png"),
    fullPage: true,
  });
});

test("taxonomy and hierarchy picker remain bounded on a phone", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const suffix = Date.now();
  const rootName = `Phone taxonomy root ${suffix}`;
  const typeName = `Phone taxonomy type ${suffix}`;
  const root = await seedProductCategoryPrerequisite(page, { name: rootName });
  await seedProductCategoryPrerequisite(page, {
    name: typeName,
    parentId: root.id,
  });

  await page.goto("/products?create=true");
  await waitForFormHydration(page);
  const picker = page.getByRole("dialog").getByRole("combobox", {
    name: "Classification",
    exact: true,
  });
  await selectComboboxItem(page, picker, `${rootName} / ${typeName}`);
  await expect(picker).toHaveValue(`${rootName} / ${typeName}`);
  await expectViewportBounded(page);
  await page.screenshot({
    path: test.info().outputPath("classification-phone.png"),
    fullPage: true,
  });
});
