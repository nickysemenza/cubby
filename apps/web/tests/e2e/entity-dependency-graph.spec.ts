import {
  seedImagePrerequisite,
  seedInventoryPrerequisites,
  seedTaskPrerequisite,
} from "./e2e-fixtures";
import {
  expectViewportBounded,
  waitForAppHydration,
  waitForFormHydration,
} from "./e2e-helpers";
import { expect, test } from "./e2e-test";

test("work graph renders through Viz, restores filters, and opens a graph node", async ({
  page,
}, testInfo) => {
  const name = `e2e graph task ${Date.now()}`;
  const task = await seedTaskPrerequisite(page, { name });
  const disconnectedName = `e2e graph task disconnected ${Date.now()}`;
  const disconnectedTask = await seedTaskPrerequisite(page, {
    name: disconnectedName,
  });

  await page.goto("/entities?tab=work");
  await waitForAppHydration(page);

  const graph = page.locator('svg[aria-label="Entity dependency graph"]');
  await expect(graph).toBeVisible({ timeout: 15_000 });
  await expect(graph.locator("a").filter({ hasText: name })).toBeVisible();
  const graphLink = graph.locator("a").filter({ hasText: name });
  await expect(graphLink).toHaveAttribute("xlink:href", `/tasks/${task.id}`);
  await expect(
    graph.locator("a").filter({ hasText: disconnectedName }),
  ).toHaveAttribute("xlink:href", `/tasks/${disconnectedTask.id}`);
  // Isolated work records are rendered as independently laid-out nested SVGs,
  // then packed by the worker instead of being spaced by one global DOT graph.
  await expect
    .poll(() => graph.locator("svg").count())
    .toBeGreaterThanOrEqual(2);

  const viewport = page.getByRole("region", {
    name: "Scrollable dependency graph",
  });
  await expect(viewport).toBeVisible();
  const initialWidth = await graph.evaluate(
    (svg) => svg.getBoundingClientRect().width,
  );
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await expect
    .poll(() => graph.evaluate((svg) => svg.getBoundingClientRect().width))
    .toBeGreaterThan(initialWidth);
  await page
    .getByRole("button", { name: "Readable view", exact: true })
    .click();
  await expect
    .poll(() => graph.evaluate((svg) => svg.getBoundingClientRect().width))
    .toBeCloseTo(initialWidth, 1);
  await expect(page.getByLabel("Graph zoom", { exact: true })).toHaveText(
    "100%",
  );

  const types = page.getByRole("combobox", { name: "Record types" });
  await types.selectOption("project");
  await expect(graphLink).toHaveCount(0);
  await types.selectOption("task");
  await expect(graphLink).toBeVisible();

  const find = page.getByRole("textbox", { name: "Find graph record" });
  await find.fill(name);
  await expect(page).toHaveURL((url) => url.searchParams.get("q") === name);
  await page.reload();
  await waitForAppHydration(page);
  await expect(find).toHaveValue(name);
  await expect(types).toHaveValue("task");
  await expect(graph).toBeVisible({ timeout: 15_000 });

  await page.screenshot({
    path: testInfo.outputPath("entity-dependency-graph-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(graph).toBeVisible();
  await expectViewportBounded(page);
  await expect
    .poll(async () =>
      graph.evaluate((svg) => {
        const frame = svg.getBoundingClientRect();
        return Array.from(svg.querySelectorAll("a")).every((link) => {
          const bounds = link.getBoundingClientRect();
          return bounds.left >= frame.left && bounds.right <= frame.right;
        });
      }),
    )
    .toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("entity-dependency-graph-phone.png"),
    fullPage: true,
  });

  await graphLink.click();
  await expect(page).toHaveURL(new RegExp(`/tasks/${task.id}$`));
});

test("legacy recipe graph URL still opens its graph controls", async ({
  page,
}) => {
  await page.goto("/recipes/new");
  await waitForFormHydration(page);
  await page
    .getByPlaceholder("Enter recipe name")
    .fill(`E2E graph recipe ${Date.now()}`);
  await page.getByRole("button", { name: /Add Instruction/i }).click();
  await page.getByRole("textbox", { name: "Step" }).fill("Stir until smooth.");
  await page.getByRole("button", { name: /^Create$/i }).click();
  await expect(page).toHaveURL(/\/recipes\/RCP-[A-Z0-9]{4}/, {
    timeout: 15000,
  });
  await page.goto("/entities?tab=recipes&hide=false");
  await waitForAppHydration(page);

  await expect(page.getByRole("tab", { name: "Recipe graph" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByText(/Each arrow means “uses”/u)).toBeVisible();
  await expect(
    page.getByRole("checkbox", { name: "Hide unconnected recipes" }),
  ).not.toBeChecked();
  await expect(
    page.locator('svg[aria-label="Entity dependency graph"]'),
  ).toBeVisible({ timeout: 15_000 });
});

test("cross-entity explorer selects and expands a manifest relationship", async ({
  page,
}, testInfo) => {
  const suffix = Date.now();
  const productName = `e2e graph product ${suffix}`;
  const locationName = `e2e graph location ${suffix}`;
  const { products, location } = await seedInventoryPrerequisites(page, {
    locationName,
    products: [{ name: productName, quantity: 1, unit: "each" }],
  });
  const product = products[0]!;

  await page.goto(
    `/entities?tab=explore&entity=product&root=${encodeURIComponent(product.id)}&view=graph`,
  );
  await waitForAppHydration(page);

  const graph = page.locator('svg[aria-label="Entity dependency graph"]');
  await expect(graph).toBeVisible({ timeout: 15_000 });
  const inventoryBranch = page
    .getByRole("heading", { name: "Inventory", exact: true })
    .locator("..");
  await inventoryBranch
    .getByRole("button", { name: "Collapse", exact: true })
    .click();
  await expect(graph.locator(".node")).toHaveCount(1);
  await inventoryBranch
    .getByRole("button", { name: "Show 1", exact: true })
    .click();
  await expect(graph.locator(".node")).toHaveCount(2);
  const connection = graph.locator(".edge").first();
  await connection.press("Enter");
  await expect(
    page.getByRole("complementary", { name: "Connection details" }),
  ).toBeVisible();
  await expect(connection).toHaveClass(/graph-edge-active/);
  await connection.press("Escape");
  await expect(
    page.getByRole("complementary", { name: "Connection details" }),
  ).toHaveCount(0);

  await page.screenshot({
    path: testInfo.outputPath("entity-relationship-explorer-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await waitForAppHydration(page);
  await expect(graph).toBeVisible();
  await expectViewportBounded(page);
  await graph.evaluate((svg) => svg.scrollIntoView({ block: "center" }));
  await page.screenshot({
    path: testInfo.outputPath("entity-relationship-explorer-phone.png"),
    fullPage: false,
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  const records = page.getByText(/Record and relationship list/u);
  await records.click();
  const explore = records.locator("..").getByRole("button", {
    name: new RegExp(`^Explore ${productName}$`),
  });
  await expect(explore).toBeVisible();
  await explore.click();

  // The initial product frontier contains its inventory record. Selecting that
  // record loads its own neighborhood, reaching Location without bulk expansion.
  const exploreItems = records.locator("..").getByRole("button", {
    name: /^Explore /,
  });
  await expect(exploreItems).toHaveCount(2);
  await exploreItems.nth(1).click();
  await expect(graph.locator(".node")).toHaveCount(3);
  await page.getByRole("button", { name: "Previous visited record" }).click();
  await expect(graph.locator(".node")).toHaveCount(2);
  await page.getByRole("button", { name: "Next visited record" }).click();
  await expect(graph.locator(".node")).toHaveCount(3);
  await page.reload();
  await waitForAppHydration(page);
  await expect(graph.locator(".node")).toHaveCount(3);
  await page.getByRole("button", { name: "List view" }).click();
  await expect(page.getByRole("link", { name: locationName })).toHaveAttribute(
    "href",
    `/locations/${location.id}`,
  );
  await page.screenshot({
    path: testInfo.outputPath("entity-relationship-explorer-list.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Back to start", exact: true })
    .click();
  const destination = page.getByRole("combobox", {
    name: "Destination",
    exact: true,
  });
  await destination.click();
  await destination.fill(locationName);
  await page
    .getByRole("option", { name: new RegExp(`^${locationName} Location`) })
    .click();
  await expect(
    page.getByRole("button", { name: /Path 1.*2 hops/ }),
  ).toBeVisible({ timeout: 15000 });
  await expect(graph.locator(".node")).toHaveCount(3);
  await page
    .getByRole("button", { name: "Return to explored records" })
    .click();
  await page.goto(`/products/${product.id}`);
  await waitForAppHydration(page);
  await page.getByRole("tab", { name: "Relations", exact: true }).click();
  await expect(page.getByRole("link", { name: "Open explorer" })).toBeVisible();
});

test("graph thumbnails retain label space and navigation", async ({ page }) => {
  const name = `graph-thumbnail-${Date.now()}`;
  const image = await seedImagePrerequisite(name);
  await page.route(`**/e2e-${name}`, (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#16845b"/></svg>',
    }),
  );
  await page.goto(
    `/entities?tab=explore&entity=image&root=${encodeURIComponent(image.id)}&view=graph`,
  );
  await waitForAppHydration(page);
  const graph = page.locator('svg[aria-label="Entity dependency graph"]');
  const thumbnail = graph.locator("image");
  await expect(thumbnail).toBeVisible({ timeout: 15000 });
  expect(
    await graph.locator(".node").evaluate((node) => {
      const thumbnail = node.querySelector("image")!.getBoundingClientRect();
      return [...node.querySelectorAll("text")]
        .filter((label) => label.textContent?.trim())
        .every(
          (label) => label.getBoundingClientRect().left >= thumbnail.right,
        );
    }),
  ).toBe(true);
  await expect(graph.locator("a")).toHaveAttribute(
    "xlink:href",
    `/images/${image.id}`,
  );
});
