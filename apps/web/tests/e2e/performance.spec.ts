import { openCommandPalette, waitForAppHydration } from "./e2e-helpers";
import { expect, test } from "./e2e-test";

test("Home renders its compact critical cards", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(
    page.getByRole("heading", { name: "Needs attention" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Household signals" }),
  ).toBeVisible();
});

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
  const inventoryListRequests: Array<{ url: string; body: string }> = [];
  page.on("request", (request) => {
    const body = request.postData() ?? "";
    const normalizedBody = body.replace(/[\\\s]/gu, "");
    if (
      request.url().includes("/_serverFn/") &&
      normalizedBody.includes('"entity":"inventory"') &&
      normalizedBody.includes('"pagination"')
    ) {
      inventoryListRequests.push({ url: request.url(), body });
    }
  });

  await page.goto("/locations", { waitUntil: "networkidle" });

  await expect(page.getByRole("heading", { name: "Locations" })).toBeVisible();
  expect(inventoryListRequests).toEqual([]);
});

test("closed Calendar subscription dialog defers its Start feed read", async ({
  page,
}) => {
  const startRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/_serverFn/")) {
      startRequests.push(
        `${decodeURIComponent(request.url())}${request.postData() ?? ""}`,
      );
    }
  });

  await page.goto("/calendar", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("button", { name: "Subscribe" })).toBeVisible();
  await expect
    .poll(() => startRequests.join("\n"), {
      message: "the hydrated calendar should issue its visible range query",
    })
    .toContain("startDate");
  const requestsBeforeOpen = startRequests.length;

  await page.getByRole("button", { name: "Subscribe" }).click();
  await expect(
    page.getByRole("heading", { name: "Subscribe in Calendar" }),
  ).toBeVisible();
  await expect
    .poll(() => startRequests.length, {
      message: "opening the dialog should activate its feed query",
    })
    .toBeGreaterThan(requestsBeforeOpen);
});

test("MCP catalog tab activates its deferred Start read", async ({ page }) => {
  const startRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/_serverFn/"))
      startRequests.push(request.url());
  });

  await page.goto("/mcp", { waitUntil: "domcontentloaded" });
  await waitForAppHydration(page);
  await expect(page.getByRole("tab", { name: "Usage" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const requestsBeforeCatalog = startRequests.length;

  await page.getByRole("tab", { name: "Catalog" }).click();
  await expect(page.getByRole("tab", { name: "Catalog" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect
    .poll(() => startRequests.length, {
      message: "activating the tab should mount its catalog query",
    })
    .toBeGreaterThan(requestsBeforeCatalog);
});
