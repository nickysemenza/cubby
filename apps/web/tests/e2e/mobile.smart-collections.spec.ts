import {
  expectViewportBounded,
  gotoAuthenticatedPage,
  reloadAuthenticatedPage,
} from "./e2e-helpers";
import { seedInventoryPrerequisites } from "./e2e-fixtures";
import { expect, test } from "./e2e-test";

test("smart Collection rules remain temporary across navigation and refresh", async ({
  page,
}) => {
  const suffix = Date.now();
  const productName = `E2E finishing brush ${suffix}`;
  const seeded = await seedInventoryPrerequisites(page, {
    locationName: `E2E finishing shelf ${suffix}`,
    products: [{ name: productName, quantity: 1, unit: "each" }],
  });
  const productId = seeded.products.at(0)?.id;
  if (!productId)
    throw new Error("Smart Collection fixture created no Product");

  await gotoAuthenticatedPage(
    page,
    "/collections",
    page.getByRole("heading", { name: "Smart starters" }),
  );
  await page.getByRole("link", { name: /^Measuring & layout/u }).click();
  await expect(
    page.getByRole("heading", {
      level: 2,
      name: "Measuring & layout products",
    }),
  ).toBeVisible();
  const productLink = page.getByRole("link", { name: productName });
  await expect(productLink).toHaveCount(0);

  const editorTrigger = page.getByRole("button", {
    name: "Edit temporary rules",
  });
  await editorTrigger.focus();
  await page.keyboard.press("Enter");

  const nameInput = page.getByRole("textbox", { name: "Collection name" });
  await nameInput.focus();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("Finishing bench");

  const conditionValue = page.getByRole("textbox", {
    name: "Condition 1 value",
  });
  await conditionValue.focus();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("finishing");

  await expect(
    page.getByText("Temporary changes", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(/^Edits reset when you refresh\./u),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { level: 2, name: "Finishing bench products" }),
  ).toBeVisible();
  await expect(productLink).toBeVisible();
  await expect(page.getByText("Dynamic", { exact: true }).last()).toBeVisible();
  await expect(page.getByText(/matches current location/u)).toBeVisible();
  await expectViewportBounded(page);
  const whyIncluded = page.getByRole("button", { name: /^Why included:/u });
  await whyIncluded.click();
  await expect(
    page.getByText("Why this Product is included", { exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");

  const reset = page.getByRole("button", { name: "Reset to starter" });
  expect((await editorTrigger.boundingBox())?.height).toBeGreaterThanOrEqual(
    44,
  );
  expect((await reset.boundingBox())?.height).toBeGreaterThanOrEqual(44);

  await productLink.click();
  await expect(page).toHaveURL(new RegExp(`/products/${productId}$`, "u"));
  await page.goBack();
  await expect(page).toHaveURL(/\/collections\/smart\/measuring$/u);
  await expect(
    page.getByRole("heading", { level: 2, name: "Finishing bench products" }),
  ).toBeVisible();
  await expect(productLink).toBeVisible();

  await reset.click();
  await expect(
    page.getByRole("heading", {
      level: 2,
      name: "Measuring & layout products",
    }),
  ).toBeVisible();
  await expect(productLink).toHaveCount(0);

  if ((await editorTrigger.getAttribute("aria-expanded")) !== "true") {
    await editorTrigger.click();
  }
  await nameInput.fill("Finishing bench");
  await conditionValue.fill("finishing");
  await expect(productLink).toBeVisible();
  await reloadAuthenticatedPage(
    page,
    page.getByRole("heading", {
      level: 2,
      name: "Measuring & layout products",
    }),
  );
  await expect(productLink).toHaveCount(0);
});
