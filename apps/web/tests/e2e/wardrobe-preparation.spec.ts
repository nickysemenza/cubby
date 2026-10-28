import {
  seedProductCategoryPrerequisite,
  seedProductPrerequisite,
} from "./fixtures/catalog";
import {
  attachProductImagePrerequisite,
  seedImagePrerequisite,
} from "./fixtures/photos";
import {
  gotoAuthenticatedPage,
  selectComboboxItem,
} from "./support/e2e-helpers";
import { expect, test } from "./support/e2e-test";

test("taxonomy edits keep product classification paths and labels separate from covers", async ({
  page,
  e2eRuntime,
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
    editor.getByRole("combobox", { name: "Parent", exact: true }),
    destinationRoot,
  );
  await editor
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(editor).not.toBeVisible({ timeout: 15_000 });
  await expect(
    page.getByRole("heading", { level: 1, name: renamedType }),
  ).toBeVisible();

  const product = await seedProductPrerequisite(page, {
    name: productName,
    categoryId: type.id,
  });
  const productId = product.id;
  const itemImageName = `wardrobe-item-${suffix}`;
  const labelImageName = `wardrobe-label-${suffix}`;
  const [itemImage, labelImage] = await Promise.all([
    seedImagePrerequisite(itemImageName, e2eRuntime.objectStorageUrl),
    seedImagePrerequisite(labelImageName, e2eRuntime.objectStorageUrl),
  ]);
  await Promise.all([
    attachProductImagePrerequisite(page, itemImage.id, productId, "item"),
    attachProductImagePrerequisite(page, labelImage.id, productId, "label"),
  ]);
  await gotoAuthenticatedPage(
    page,
    `/products/${productId}`,
    page.getByRole("heading", { level: 1, name: productName }),
  );
  await expect(
    page.getByText(`${destinationRoot} / ${renamedType}`, { exact: true }),
  ).toBeVisible();
  await page.locator("#images").scrollIntoViewIfNeeded();
  await expect(
    page.locator("#images").getByRole("img", { name: `${itemImageName}.png` }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page
        .locator("#images")
        .getByRole("img", { name: `${itemImageName}.png` })
        .evaluate(
          (node) => node instanceof HTMLImageElement && node.naturalWidth > 0,
        ),
    )
    .toBe(true);
  await expect(
    page.locator("#images").getByRole("img", { name: `${labelImageName}.png` }),
  ).toHaveCount(0);
  await expect(
    page
      .getByTestId("detail-spec-plate")
      .getByRole("img", { name: `${labelImageName}.png` }),
  ).toHaveCount(0);
  const cover = page
    .getByTestId("detail-spec-plate")
    .getByRole("img", { name: "Record cover" });
  await expect(cover).toBeVisible();
  await expect
    .poll(() =>
      cover.evaluate(
        (node) => node instanceof HTMLImageElement && node.naturalWidth > 0,
      ),
    )
    .toBe(true);
  const labels = page.locator("#labels");
  await labels.scrollIntoViewIfNeeded();
  await expect(
    labels.getByRole("img", { name: `${labelImageName}.png` }),
  ).toBeVisible();
  await expect(
    labels.getByRole("img", { name: `${itemImageName}.png` }),
  ).toHaveCount(0);
  await page.getByTestId("detail-spec-plate").scrollIntoViewIfNeeded();
});
