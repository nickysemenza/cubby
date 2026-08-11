import { expect, test } from "@playwright/test";
import { createProduct } from "./e2e-helpers";

test("Product filters persist while switching movement renderers", async ({
  page,
}) => {
  const manufacturer = `Timeline Tools ${Date.now()}`;
  await createProduct(page, `Timeline Product ${Date.now()}`, { manufacturer });

  await page.goto(
    `/products?manufacturer=${encodeURIComponent(manufacturer)}&view=events`,
  );
  await expect(page.getByRole("group", { name: "Products view" })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByLabel("From", { exact: true })).toBeVisible();
  await expect(page.getByLabel("To", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Events view" }),
  ).toHaveAttribute("aria-pressed", "true");

  await page.getByRole("button", { name: "Lifecycles view" }).click();
  await expect(page).toHaveURL(/view=lifecycles/);
  await expect(page).toHaveURL(
    new RegExp(`manufacturer=${encodeURIComponent(manufacturer)}`),
  );
  await expect(
    page.getByRole("button", { name: "Lifecycles view" }),
  ).toHaveAttribute("aria-pressed", "true");

  await page.getByRole("button", { name: "Table view" }).click();
  await expect(page).not.toHaveURL(/(?:\?|&)view=/);
  await expect(page).toHaveURL(
    new RegExp(`manufacturer=${encodeURIComponent(manufacturer)}`),
  );
});
