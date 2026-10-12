import { fileURLToPath } from "node:url";

import {
  gotoAuthenticatedPage,
  expectViewportBounded,
  openProductFromPalette,
  waitForFormHydration,
} from "./e2e-helpers";
import { expect, test } from "./e2e-test";

const itemPhoto = fileURLToPath(
  new URL("./fixtures/synthetic-wardrobe-shirt.png", import.meta.url),
);
const labelPhoto = fileURLToPath(
  new URL("./fixtures/synthetic-wardrobe-label.png", import.meta.url),
);

test("a member creates a Product from own item and label photos without an import run", async ({
  page,
}, testInfo) => {
  const name = `Photo-first crew shirt ${Date.now()}`;
  await gotoAuthenticatedPage(page, "/products?create=true");
  await waitForFormHydration(page);
  const editor = page.getByRole("dialog");
  await editor.getByRole("textbox", { name: "Name", exact: true }).fill(name);

  await editor.getByLabel("Choose image").setInputFiles(itemPhoto);
  await expect(
    editor.getByRole("button", { name: "Remove synthetic-wardrobe-shirt.png" }),
  ).toBeVisible();
  await expect(editor.getByText("New images")).toBeVisible();
  await expect(editor.getByText("Uploading images")).toHaveCount(0);
  await editor.getByLabel("Attach as").selectOption("label");
  await editor.getByLabel("Choose image").setInputFiles(labelPhoto);
  await expect(
    editor.getByRole("button", { name: "Remove synthetic-wardrobe-label.png" }),
  ).toBeVisible();
  await expect(editor.getByText("Uploading images")).toHaveCount(0);

  await editor.getByRole("button", { name: /^Create$/ }).click();
  await expect(editor).not.toBeVisible({ timeout: 15_000 });
  await openProductFromPalette(page, name);
  await expect(
    page
      .locator("#images")
      .getByRole("img", { name: "synthetic-wardrobe-shirt.png" }),
  ).toBeVisible();
  await expect(
    page
      .locator("#labels")
      .getByRole("img", { name: "synthetic-wardrobe-label.png" }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page
      .locator("#images")
      .getByRole("img", { name: "synthetic-wardrobe-shirt.png" }),
  ).toBeVisible();
  await expect(
    page
      .locator("#labels")
      .getByRole("img", { name: "synthetic-wardrobe-label.png" }),
  ).toBeVisible();
  await page.setViewportSize({ width: 402, height: 874 });
  const photo = page.getByTestId("detail-spec-plate").getByRole("button", {
    name: "View synthetic-wardrobe-shirt.png",
    exact: true,
  });
  await expect(photo).toBeVisible();
  const bounds = await photo.boundingBox();
  const titleBounds = await page
    .getByRole("heading", { name, exact: true })
    .boundingBox();
  expect(bounds).not.toBeNull();
  expect(titleBounds).not.toBeNull();
  expect(bounds!.width).toBeLessThanOrEqual(320);
  expect(bounds!.height).toBeLessThanOrEqual(176);
  expect(bounds!.y + bounds!.height).toBeLessThan(titleBounds!.y);
  await expectViewportBounded(page);
  await page.screenshot({
    path: testInfo.outputPath("phone-photo-dossier.png"),
  });
  await photo.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
});
