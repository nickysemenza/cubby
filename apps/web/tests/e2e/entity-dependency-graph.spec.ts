import {
  seedInventoryPrerequisites,
  seedTaskPrerequisite,
  seedProjectPrerequisite,
} from "./fixtures/catalog";
import {
  seedImagePrerequisite,
  attachProductImagePrerequisite,
} from "./fixtures/photos";
import {
  chooseOption,
  gotoAuthenticatedPage,
  waitForAppHydration,
} from "./support/e2e-helpers";
import { expect, test } from "./support/e2e-test";
import { createEntityFixture } from "./fixtures/core";

// Regression boundaries: card money must come from the canonical read, curated
// context must retain its actual purchase/project evidence, and paths stay links.
test("connections workspace shares dense facts, linked paths, and native handoff", async ({
  page,
  e2eRuntime,
}, testInfo) => {
  const name = `Connection light ${Date.now()}`;
  const { products } = await seedInventoryPrerequisites(page, {
    locationName: "Connection garden path",
    products: [{ name, quantity: 6, unit: "each" }],
  });
  const product = products[0]!;
  const image = await seedImagePrerequisite(
    "Connection light cover",
    e2eRuntime.objectStorageUrl,
  );
  await attachProductImagePrerequisite(page, image.id, product.id, "item");
  const project = await seedProjectPrerequisite(
    page,
    "Connection patio project",
  );
  await createEntityFixture(page, "expense", {
    name: "Connection lighting purchase",
    cost: 204,
    date: "2026-09-09",
    costType: "materials",
    trade: "other",
    productId: product.id,
    productQuantity: 6,
    projectId: project.id,
  });
  await gotoAuthenticatedPage(page, `/products/${product.id}`);
  const context = page.getByRole("region", { name: "Connection context" });
  await expect(
    context.getByRole("link", { name: "Connection patio project" }),
  ).toBeVisible();
  await context
    .getByText("Show connection paths", { exact: true })
    .first()
    .click();
  await expect(
    context.getByRole("link", { name: "Connection lighting purchase" }),
  ).toBeVisible();
  await context
    .getByRole("link", { name: "Open connections", exact: true })
    .click();
  const graph = page.getByLabel("Relationship graph", { exact: true });
  const card = graph.locator(
    `.react-flow__node[data-id="product:${product.id}"]`,
  );
  await expect(card.getByText("$204.00", { exact: true })).toBeVisible();
  await expect(card.locator("dl dt")).not.toHaveCount(0);
  await expect(card.locator(".graph-record-identity img")).toBeVisible();
  await page.getByRole("button", { name: "Paths list", exact: true }).click();
  const paths = page.getByLabel("Connection paths", { exact: true });
  await expect(
    paths.locator(`a[href="/products/${product.id}"]`).first(),
  ).toBeVisible();
  await expect(
    paths.getByRole("link", { name: "Connection lighting purchase" }).first(),
  ).toBeVisible();
  await page.getByRole("button", { name: "Paths list", exact: true }).click();
  await page.getByRole("button", { name: "Inspector", exact: true }).click();
  await page.getByRole("button", { name: "Fit map", exact: true }).click();
  await testInfo.attach("Dense connections desktop", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Paths list", exact: true }).click();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await testInfo.attach("Dense connection paths phone", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
  await page.addInitScript(() => {
    window.workspaceTestMessages = [];
    window.webkit = {
      messageHandlers: {
        cubbyWorkspace: {
          postMessage: (message) => window.workspaceTestMessages.push(message),
        },
      },
    };
  });
  await gotoAuthenticatedPage(
    page,
    `/connections?source=product&id=${product.id}&nativeWorkspace=connections`,
  );
  await expect(page.locator("[data-native-workspace]")).toBeVisible();
  await expect(page.locator('[data-app-shell="authenticated"]')).toHaveCount(0);
  await page.getByRole("button", { name: "Paths list", exact: true }).click();
  const recordLink = page
    .getByLabel("Connection paths")
    .locator(`a[href*="/products/${product.id}"]`)
    .first();
  const hostedURL = page.url();
  await recordLink.click();
  await expect
    .poll(() => page.evaluate(() => window.workspaceTestMessages))
    .toContainEqual({
      version: 1,
      type: "navigate",
      entity: "product",
      id: product.id,
      replace: false,
    });
  await expect(page).toHaveURL(hostedURL);
});

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
  await chooseOption(page, types, "Projects only");
  await expect(graphLink).toHaveCount(0);
  await chooseOption(page, types, "Tasks only");
  await expect(graphLink).toBeVisible();

  const find = page.getByRole("textbox", { name: "Find graph record" });
  await find.fill(name);
  await expect(page).toHaveURL((url) => url.searchParams.get("q") === name);
  await page.reload();
  await waitForAppHydration(page);
  await expect(find).toHaveValue(name);
  await expect(types).toHaveText(/Tasks only/);
  await expect(graph).toBeVisible({ timeout: 15_000 });

  await graphLink.click();
  await expect(page).toHaveURL(new RegExp(`/tasks/${task.id}$`));
});

test("legacy recipe graph URL still opens its graph controls", async ({
  page,
}) => {
  await createEntityFixture(page, "recipe", {
    name: `E2E graph recipe ${Date.now()}`,
    meta: null,
    sections: [
      {
        instructions: [{ instruction: "Stir until smooth." }],
      },
    ],
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
  await records.getByRole("button", { name: /^Inspect .*Inventory/ }).click();
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
    .getByRole("button", { name: `Inspect ${locationName}`, exact: true })
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

  await gotoAuthenticatedPage(page, `/products/${product.id}`);
  await page
    .getByRole("heading", { level: 2, name: "Relations", exact: true })
    .scrollIntoViewIfNeeded();
  // A detail page's Relationships section is the explorer itself.
  await expect(
    page.getByRole("link", { name: "Open graph", exact: true }),
  ).toBeVisible();
});

test("graph thumbnails retain label space and canonical navigation", async ({
  page,
  e2eRuntime,
}) => {
  const name = `graph-thumbnail-${Date.now()}`;
  const image = await seedImagePrerequisite(name, e2eRuntime.objectStorageUrl);
  await gotoAuthenticatedPage(page, `/graph?entity=image&root=${image.id}`);
  const card = page
    .getByLabel("Relationship graph", { exact: true })
    .locator(".graph-map-record")
    .first();
  await expect(card.locator("img")).toBeVisible({ timeout: 15000 });
  await expect
    .poll(() =>
      card
        .locator("img")
        .evaluate(
          (node) => node instanceof HTMLImageElement && node.naturalWidth > 0,
        ),
    )
    .toBe(true);
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
