import { expect, test } from "@playwright/test";
import { openCommandPalette } from "./e2e-helpers";

test("authenticated navigation chrome does not wait for idle", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "requestIdleCallback", {
      configurable: true,
      value: () => 1,
    });
  });

  await page.goto("/", { waitUntil: "domcontentloaded" });

  await expect(
    page.getByRole("button", { name: "Cook", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Pantry", exact: true }),
  ).toBeVisible();
});

test("a prewarmed Command-K opens without a visible loading state", async ({
  page,
}) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const trigger = page.getByRole("button", { name: "Search", exact: true });

  await trigger.hover();
  await page.waitForTimeout(100);
  const palette = await openCommandPalette(page);

  await expect(palette).toBeVisible();
  await expect(
    palette.getByPlaceholder("Search, jump to a page, or ask Cubby…"),
  ).toBeFocused();
});

test("intent-preloaded navigation does not flash the route skeleton", async ({
  page,
}) => {
  await page.goto("/", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Pantry", exact: true }).click();
  const locations = page.getByRole("menuitem", {
    name: "Locations",
    exact: true,
  });
  await expect(locations).toBeVisible();
  await locations.hover();
  await page.waitForTimeout(100);
  await locations.click();

  await page.waitForTimeout(250);
  await expect(page.locator('main [data-slot="skeleton"]')).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Locations" })).toBeVisible();
});

test("Locations gallery does not paginate the complete inventory", async ({
  page,
}) => {
  const inventoryListRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/trpc/inventory.list")) {
      inventoryListRequests.push(request.url());
    }
  });

  await page.goto("/locations", { waitUntil: "networkidle" });

  await expect(page.getByRole("heading", { name: "Locations" })).toBeVisible();
  expect(inventoryListRequests).toEqual([]);
});
