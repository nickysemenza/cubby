import { seedProductPrerequisite } from "./e2e-fixtures";
import { waitForAppHydration } from "./e2e-helpers";
import { expect, test } from "./e2e-test";

test("Product filters persist while switching movement renderers", async ({
  page,
}) => {
  const manufacturer = `Timeline Tools ${Date.now()}`;
  await seedProductPrerequisite(page, {
    name: `Timeline Product ${Date.now()}`,
    manufacturer,
  });

  await page.goto(
    `/products?manufacturer=${encodeURIComponent(manufacturer)}&view=events`,
  );
  await waitForAppHydration(page);
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
  expect(new URL(page.url()).searchParams.get("manufacturer")).toBe(
    manufacturer,
  );
  await expect(
    page.getByRole("button", { name: "Lifecycles view" }),
  ).toHaveAttribute("aria-pressed", "true");

  await page.getByRole("button", { name: "Table view" }).click();
  await expect(page).not.toHaveURL(/(?:\?|&)view=/);
  expect(new URL(page.url()).searchParams.get("manufacturer")).toBe(
    manufacturer,
  );
});
