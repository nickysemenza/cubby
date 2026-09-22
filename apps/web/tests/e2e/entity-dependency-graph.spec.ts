import {
  seedImagePrerequisite,
  seedInventoryPrerequisites,
  seedTaskPrerequisite,
} from "./e2e-fixtures";
import {
  expectViewportBounded,
  waitForAppHydration,
  waitForFormHydration,
  gotoAuthenticatedPage,
} from "./e2e-helpers";
import { expect, test } from "./e2e-test";

test("work graph renders through Viz, restores filters, and opens a graph node", async ({
  page,
}) => {
  const name = `e2e graph task ${Date.now()}`;
  const task = await seedTaskPrerequisite(page, { name });
  const disconnectedName = `e2e graph task disconnected ${Date.now()}`;
  const disconnectedTask = await seedTaskPrerequisite(page, {
    name: disconnectedName,
  });

  await gotoAuthenticatedPage(page, "/entities?tab=work");

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
  await gotoAuthenticatedPage(page, "/entities?tab=recipes&hide=false");

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

test("graph workspace keeps its map while selecting, expanding, and opening records", async ({
  page,
}) => {
  const suffix = Date.now();
  const productName = `e2e graph product ${suffix}`;
  const locationName = `e2e graph location ${suffix}`;
  const { products, location } = await seedInventoryPrerequisites(page, {
    locationName,
    products: [{ name: productName, quantity: 1, unit: "each" }],
  });
  const product = products[0]!;
  await gotoAuthenticatedPage(
    page,
    `/entities?tab=explore&entity=product&root=${product.id}&view=graph`,
  );
  await expect(page).toHaveURL((url) => url.pathname === "/graph");
  const graph = page.getByLabel("Relationship graph", { exact: true });
  const nodes = graph.locator(".react-flow__node");
  await expect(nodes).toHaveCount(2);
  const inventoryBranch = page
    .getByRole("heading", { name: "Inventory", exact: true })
    .locator("../..");
  await inventoryBranch
    .getByRole("button", { name: "Collapse", exact: true })
    .click();
  await expect(nodes).toHaveCount(1);
  await inventoryBranch
    .getByRole("button", { name: "Expand", exact: true })
    .click();
  await expect(nodes).toHaveCount(2);
  const connection = graph.locator(".react-flow__edge").first();
  await connection.press("Enter");
  await expect(page.getByLabel("Connection evidence")).toBeVisible();
  await connection.press("Escape");
  await expect(page.getByLabel("Connection evidence")).toHaveCount(0);

  await page
    .getByRole("button", { name: "Show record list", exact: true })
    .click();
  const records = page.getByLabel("Map records", { exact: true });
  await records.getByRole("button", { name: /Inventory Item$/ }).click();
  await expect(nodes).toHaveCount(2);
  const before = await nodes.evaluateAll((items) =>
    Object.fromEntries(
      items.map((item) => [
        item.getAttribute("data-id"),
        item.getAttribute("style"),
      ]),
    ),
  );
  const viewport = graph.locator(".react-flow__viewport");
  const camera = await viewport.getAttribute("style");
  await page
    .getByRole("button", { name: "Expand connections", exact: true })
    .click();
  await expect(nodes).toHaveCount(3);
  expect(await viewport.getAttribute("style")).toBe(camera);
  const after = await nodes.evaluateAll((items) =>
    Object.fromEntries(
      items.map((item) => [
        item.getAttribute("data-id"),
        item.getAttribute("style"),
      ]),
    ),
  );
  for (const [id, frame] of Object.entries(before))
    expect(after[id]).toBe(frame);
  await page
    .getByRole("button", { name: "Previous record", exact: true })
    .click();
  await expect(nodes).toHaveCount(3);
  await page.getByRole("button", { name: "Next record", exact: true }).click();
  await expect(nodes).toHaveCount(3);
  await page.getByLabel("Find explored records").fill(locationName);
  await records
    .getByRole("button", { name: new RegExp(`^${locationName}`) })
    .click();
  await page.getByRole("link", { name: "Open record", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/locations/${location.id}$`));
  await page.goBack();
  await expect(nodes).toHaveCount(3);
  await page
    .getByRole("button", { name: "Previous record", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Previous record", exact: true })
    .click();
  await page.getByText("Find a path", { exact: true }).click();
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
    page.getByRole("button", { name: /Path 1.*2 connections/ }),
  ).toBeVisible({ timeout: 15000 });
  await expect(page).toHaveURL(
    (url) => url.searchParams.get("destination") === `location:${location.id}`,
  );
  await page.getByRole("button", { name: "Clear path", exact: true }).click();
  await expect(page).toHaveURL((url) => !url.searchParams.has("destination"));

  await page.setViewportSize({ width: 390, height: 844 });
  await expectViewportBounded(page);
  await expect(
    page.getByRole("heading", { name: "Graph inspector", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page
    .getByRole("button", { name: "Inspect selection", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Graph inspector", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  expect(
    await page
      .getByLabel("Find explored records")
      .evaluate((input) => input.getBoundingClientRect().width),
  ).toBeGreaterThan(300);
  await page.setViewportSize({ width: 1280, height: 900 });
  await gotoAuthenticatedPage(page, `/products/${product.id}`);
  await page.getByRole("tab", { name: "Relations", exact: true }).click();
  await page.getByRole("button", { name: "Graph view", exact: true }).click();
  await expect(
    page.getByRole("link", { name: "Open graph", exact: true }),
  ).toBeVisible();
});

test("graph thumbnails retain label space and canonical navigation", async ({
  page,
}) => {
  const name = `graph-thumbnail-${Date.now()}`;
  const image = await seedImagePrerequisite(name);
  await page.route(`**/e2e-${name}`, (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#16845b"/></svg>',
    }),
  );
  await gotoAuthenticatedPage(page, `/graph?entity=image&root=${image.id}`);
  const card = page
    .getByLabel("Relationship graph", { exact: true })
    .locator(".graph-map-record")
    .first();
  await expect(card.locator("img")).toBeVisible({ timeout: 15000 });
  expect(
    await card.evaluate((node) => {
      const thumbnail = node.querySelector("img")!.getBoundingClientRect();
      const title = node.querySelector("[title]")!.getBoundingClientRect();
      return (
        title.left >= thumbnail.right &&
        title.right <= node.getBoundingClientRect().right
      );
    }),
  ).toBe(true);
  await expect(
    page.getByRole("link", { name: "Open record", exact: true }),
  ).toHaveAttribute("href", `/images/${image.id}`);
});
