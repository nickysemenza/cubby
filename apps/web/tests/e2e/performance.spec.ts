import { openCommandPalette } from "./e2e-helpers";
import { expect, test } from "./e2e-test";

test("Home batches compact critical reads once and keeps hidden reads dormant", async ({
  page,
}) => {
  const trpcRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/trpc")) trpcRequests.push(request.url());
  });

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(
    page.getByRole("heading", { name: "Needs attention" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Household signals" }),
  ).toBeVisible();

  const critical = [
    "problems.getCounts",
    "task.summary",
    "meal.upcomingSummary",
    "location.valuationSummary",
    "expense.monthlySummary",
  ];
  await expect
    .poll(
      () =>
        critical.every((procedure) =>
          trpcRequests.join("\n").includes(procedure),
        ),
      {
        message: "all compact Home procedures should join the initial request",
      },
    )
    .toBe(true);
  const criticalRequests = trpcRequests.filter((url) =>
    critical.some((procedure) => url.includes(procedure)),
  );
  expect(
    new Set(criticalRequests).size,
    `critical requests:\n${criticalRequests.join("\n")}`,
  ).toBe(1);
  for (const procedure of critical) {
    expect(
      criticalRequests.filter((url) => url.includes(procedure)),
      `${procedure} should appear in the initial batch exactly once`,
    ).toHaveLength(1);
  }

  const initialUrls = trpcRequests.join("\n");
  expect(initialUrls).not.toContain("location.makeTree");
  expect(initialUrls).not.toContain("dashboard.counts");
  expect(initialUrls).not.toContain("meal.getByDateRange");
  expect(initialUrls).not.toContain("expense.analytics");
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

test("closed Calendar subscription dialog performs no feed read", async ({
  page,
}) => {
  const trpcRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/trpc")) trpcRequests.push(request.url());
  });

  await page.goto("/calendar", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("button", { name: "Subscribe" })).toBeVisible();
  await expect
    .poll(() => trpcRequests.join("\n"), {
      message: "the hydrated calendar should issue its visible range query",
    })
    .toContain("calendar.range");
  expect(trpcRequests.join("\n")).not.toContain("calendar.getFeed");

  await page.getByRole("button", { name: "Subscribe" }).click();
  await expect(
    page.getByRole("heading", { name: "Subscribe in Calendar" }),
  ).toBeVisible();
  await expect
    .poll(() => trpcRequests.join("\n"), {
      message: "opening the dialog should activate its feed query",
    })
    .toContain("calendar.getFeed");
});

test("inactive MCP catalog tab performs no catalog read", async ({ page }) => {
  const trpcRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/trpc")) trpcRequests.push(request.url());
  });

  await page.goto("/mcp", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("tab", { name: "Usage" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect
    .poll(() => trpcRequests.join("\n"), {
      message: "the active usage tab should finish hydrating first",
    })
    .toContain("mcp.usageDashboard");
  expect(trpcRequests.join("\n")).not.toContain("mcp.listTools");

  await page.getByRole("tab", { name: "Catalog" }).click();
  await expect(page.getByRole("tab", { name: "Catalog" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect
    .poll(() => trpcRequests.join("\n"), {
      message: "activating the tab should mount its catalog query",
    })
    .toContain("mcp.listTools");
});
