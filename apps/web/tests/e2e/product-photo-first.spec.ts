import { fileURLToPath } from "node:url";

import {
  gotoAuthenticatedPage,
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
}) => {
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
});
