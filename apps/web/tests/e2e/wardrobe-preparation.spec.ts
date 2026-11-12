import {
  seedProductCategoryPrerequisite,
  seedProductPrerequisite,
} from "./fixtures/catalog";
import {
  attachProductImagePrerequisite,
  seedImagePrerequisite,
} from "./fixtures/photos";
import { gotoAuthenticatedPage } from "./support/e2e-helpers";
import { expect, test } from "./support/e2e-test";

test("taxonomy edits keep product classification paths and labels separate from covers", async ({
  page,
  e2eRuntime,
}) => {
  const suffix = Date.now();
  const destinationRoot = `Wardrobe taxonomy destination ${suffix}`;
  const originalType = `Wardrobe taxonomy type ${suffix}`;
  const renamedType = `Wardrobe taxonomy renamed ${suffix}`;
  const productName = `Wardrobe classified product ${suffix}`;
  const destination = await seedProductCategoryPrerequisite(page, {
    name: destinationRoot,
  });
  const type = await seedProductCategoryPrerequisite(page, {
    name: originalType,
    parentId: destination.id,
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
  // A parent move reclassifies spending, so only the reviewed flow offers it.
  await expect(
    editor.getByRole("combobox", { name: "Parent", exact: true }),
  ).toHaveCount(0);
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
  const [itemImage, labelImage, extraImage] = await Promise.all([
    seedImagePrerequisite(itemImageName, e2eRuntime.objectStorageUrl),
    seedImagePrerequisite(labelImageName, e2eRuntime.objectStorageUrl),
    seedImagePrerequisite(
      `wardrobe-extra-${suffix}`,
      e2eRuntime.objectStorageUrl,
    ),
  ]);
  await Promise.all([
    attachProductImagePrerequisite(page, itemImage.id, productId, "item"),
    attachProductImagePrerequisite(page, labelImage.id, productId, "label"),
    attachProductImagePrerequisite(page, extraImage.id, productId, "item"),
  ]);
  await gotoAuthenticatedPage(
    page,
    `/products/${productId}`,
    page.getByRole("heading", { level: 1, name: productName }),
  );
  await expect(
    page.getByRole("link", {
      name: `${destinationRoot} / ${renamedType}`,
      exact: true,
    }),
  ).toBeVisible();
  // The Evidence tab holds Images; its panel stays mounted while streamed
  // loading elements are replaced.
  await page.getByRole("tab", { name: /^Evidence/u }).click();
  await expect(page).toHaveURL(/#evidence$/u);
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
  await gotoAuthenticatedPage(
    page,
    `/products?searchQuery=${encodeURIComponent(productName)}`,
  );
  const row = page.getByRole("row").filter({ hasText: productName });
  await expect(row).toHaveCount(1);
  await row
    .getByRole("button", { name: "Why this image", exact: true })
    .click();
  const chain = page
    .getByRole("dialog")
    .filter({ hasText: "Display image sources" });
  await expect(chain.getByRole("img")).toHaveCount(2);
  await expect(
    chain.getByRole("img", { name: "Chosen cover", exact: true }),
  ).toBeVisible();
});
