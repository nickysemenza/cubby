import { expect, test } from "@playwright/test";

test("workspace shell responds from phone navigation through desktop sidebar", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/", { waitUntil: "domcontentloaded" });

  const sidebar = page.getByRole("complementary", {
    name: "Workspace navigation",
  });
  await expect(sidebar).toBeVisible();
  // 144, not 224: the rail's own content measured 139px, so the old width
  // spent 38% of itself on nothing.
  expect((await sidebar.boundingBox())?.width).toBe(144);
  await expect(page.getByRole("link", { name: "Home" })).toHaveAttribute(
    "aria-current",
    "page",
  );

  const main = page.getByRole("main");
  const spend = main.getByText("Recorded spend", { exact: true }).first();
  const pantry = main.getByText("Pantry value", { exact: true }).first();
  await expect(spend).toBeVisible();
  await expect(pantry).toBeVisible();
  expect((await spend.boundingBox())?.y).toBeLessThan(900);
  expect((await pantry.boundingBox())?.y).toBeLessThan(900);

  await expect(
    page.getByRole("button", { name: "Account menu" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Collapse sidebar" }).click();
  await expect(
    page.getByRole("button", { name: "Expand sidebar" }),
  ).toBeVisible();
  await expect.poll(async () => (await sidebar.boundingBox())?.width).toBe(56);

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(
    page.getByRole("button", { name: "Expand sidebar" }),
  ).toBeVisible();

  await page.setViewportSize({ width: 768, height: 900 });
  await expect.poll(async () => (await sidebar.boundingBox())?.width).toBe(56);
  const home = sidebar.getByRole("link", { name: "Home", exact: true });
  await sidebar.locator('a[href="/"]').first().focus();
  await page.keyboard.press("Tab");
  await expect(home).toBeFocused();
  await expect(page.getByRole("tooltip")).toHaveText("Home");
  const cook = page.getByRole("button", { name: "Cook" });
  await expect(cook).toBeEnabled();
  await cook.click();
  await expect(
    page.getByRole("menuitem", { name: "Recipes", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");

  await page.setViewportSize({ width: 1024, height: 900 });
  await expect(
    page.getByRole("button", { name: "Expand sidebar" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Expand sidebar" }).click();
  await expect.poll(async () => (await sidebar.boundingBox())?.width).toBe(144);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(sidebar).toBeHidden();
  const bottomNav = page.getByRole("navigation", { name: "Main navigation" });
  await expect(bottomNav).toBeVisible();
  await expect(
    bottomNav.getByRole("link", { name: "Inventory", exact: true }),
  ).toBeVisible();
  const pantryBox = await pantry.boundingBox();
  const spendBox = await spend.boundingBox();
  expect(pantryBox).not.toBeNull();
  expect(spendBox).not.toBeNull();
  expect(pantryBox?.y).toBeLessThan(spendBox?.y ?? 0);
});

test("tablet rail preference does not overwrite the desktop preference", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(
    page.getByRole("button", { name: "Account menu" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Collapse sidebar" }).click();

  await page.setViewportSize({ width: 768, height: 900 });
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(
    page.getByRole("button", { name: "Expand sidebar" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Expand sidebar" }).click();
  await page.setViewportSize({ width: 768, height: 900 });
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(
    page.getByRole("button", { name: "Collapse sidebar" }),
  ).toBeVisible();
});
