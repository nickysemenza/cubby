import {
  seedInventoryPrerequisites,
  seedTaskPrerequisite,
} from "./e2e-fixtures";
import { expectViewportBounded, gotoAuthenticatedPage } from "./e2e-helpers";
import { expect, test } from "./e2e-test";

test("work graph stays inside the phone viewport and opens a graph node", async ({
  page,
}) => {
  const name = `e2e phone graph task ${Date.now()}`;
  const task = await seedTaskPrerequisite(page, { name });
  await gotoAuthenticatedPage(
    page,
    `/entities?tab=work&q=${encodeURIComponent(name)}`,
  );

  const graph = page.locator('svg[aria-label="Entity dependency graph"]');
  await expect(graph).toBeVisible({ timeout: 15_000 });
  const graphLink = graph.locator("a").filter({ hasText: name });
  await expect(graphLink).toHaveAttribute("xlink:href", `/tasks/${task.id}`);
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

test("graph workspace inspector is a reopenable sheet on a phone", async ({
  page,
}) => {
  const suffix = Date.now();
  const { products } = await seedInventoryPrerequisites(page, {
    locationName: `e2e phone graph location ${suffix}`,
    products: [
      { name: `e2e phone graph product ${suffix}`, quantity: 1, unit: "each" },
    ],
  });
  await gotoAuthenticatedPage(
    page,
    `/graph?entity=product&root=${products[0]!.id}`,
  );
  const nodes = page
    .getByLabel("Relationship graph", { exact: true })
    .locator(".react-flow__node");
  await expect(nodes).toHaveCount(2);
  await page
    .getByRole("button", { name: "Show record list", exact: true })
    .click();
  await page
    .getByLabel("Map records", { exact: true })
    .getByRole("button", { name: /Inventory Item$/ })
    .click();

  // Below md the inspector is a bottom sheet that selecting a record opens.
  const inspector = page.getByRole("heading", {
    name: "Graph inspector",
    exact: true,
  });
  await expect(inspector).toBeVisible();
  await expectViewportBounded(page);
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(inspector).toBeHidden();
  await page
    .getByRole("button", { name: "Inspect selection", exact: true })
    .click();
  await expect(inspector).toBeVisible();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(inspector).toBeHidden();
  expect(
    await page
      .getByLabel("Find explored records")
      .evaluate((input) => input.getBoundingClientRect().width),
  ).toBeGreaterThan(300);
});
