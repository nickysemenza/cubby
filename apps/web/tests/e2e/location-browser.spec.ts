import { seedProductPrerequisite } from "./fixtures/catalog";
import { createEntityFixture } from "./fixtures/core";
import { gotoAuthenticatedPage } from "./support/e2e-helpers";
import { expect, test } from "./support/e2e-test";

test("streamed standalone tree disclosure waits for its own handlers", async ({
  page,
}) => {
  await gotoAuthenticatedPage(page, "/design");
  const tree = page.getByRole("tree", {
    name: "Household locations",
    exact: true,
  });
  await tree
    .getByRole("button", { name: "Expand Pantry", exact: true })
    .click();
  await expect(
    tree.getByRole("link", { name: "Top Shelf", exact: true }),
  ).toBeVisible();
  const pantry = tree.getByRole("treeitem", { name: "Pantry", exact: true });
  await pantry.press("ArrowLeft");
  await expect(
    tree.getByRole("link", { name: "Top Shelf", exact: true }),
  ).toHaveCount(0);
});

// Regressions: gallery jumps replacing mounted sections, scrolling failing to
// track the active outline row, deep indentation, collapsed outline descendants
// remaining keyboard-reachable, and filters losing their Clear action.
test("location browser scrolls the full hierarchy, tracks navigation, and discloses contents", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const suffix = Date.now();
  const root = await createEntityFixture(page, "location", {
    name: `Synthetic studio ${suffix}`,
    type: "room",
    parentId: null,
  });
  const cabinet = await createEntityFixture(page, "location", {
    name: `Synthetic cabinet ${suffix}`,
    type: "cabinet",
    parentId: root.id,
  });
  const shelfName = `Synthetic upper shelf ${suffix}`;
  const shelf = await createEntityFixture(page, "location", {
    name: shelfName,
    type: "shelf",
    parentId: cabinet.id,
  });
  const product = await seedProductPrerequisite(page, {
    name: `Synthetic twine ${suffix}`,
  });
  await createEntityFixture(page, "inventory", {
    productId: product.id,
    locationId: cabinet.id,
    amount: { value: 2, unit: "each" },
  });
  await gotoAuthenticatedPage(page, "/locations?view=gallery");
  const browser = page.getByRole("region", { name: "Location browser" });
  const tree = browser.getByRole("tree", { name: "Locations" });
  await tree
    .getByRole("button", { name: `Synthetic studio ${suffix}`, exact: true })
    .click();
  const content = browser.getByRole("region", { name: "Location overview" });
  const rootRow = tree.getByRole("treeitem", {
    name: `Synthetic studio ${suffix}`,
    exact: true,
  });
  const cabinetRow = tree.getByRole("treeitem", {
    name: `Synthetic cabinet ${suffix}`,
    exact: true,
  });
  // New rooms belong under Home; the initial one-level expansion leaves this room closed.
  await rootRow
    .getByRole("button", {
      name: `Expand Synthetic studio ${suffix}`,
      exact: true,
    })
    .click();
  await tree
    .getByRole("button", {
      name: `Expand Synthetic cabinet ${suffix}`,
      exact: true,
    })
    .click();
  await expect(
    tree.getByRole("treeitem", { name: shelfName, exact: true }),
  ).toBeVisible();
  await tree
    .getByRole("button", {
      name: `Collapse Synthetic cabinet ${suffix}`,
      exact: true,
    })
    .click();
  await rootRow.focus();
  await rootRow.press("ArrowRight");
  await expect(cabinetRow).toBeFocused();
  await cabinetRow.press("ArrowRight");
  await expect(
    tree.getByRole("treeitem", { name: shelfName, exact: true }),
  ).toBeVisible();
  const rootBox = await rootRow.boundingBox();
  const childBox = await cabinetRow.boundingBox();
  expect(rootBox?.height).toBe(28);
  expect(childBox?.height).toBe(28);
  await cabinetRow.press("ArrowLeft");
  await expect(
    tree.getByRole("treeitem", { name: shelfName, exact: true }),
  ).toHaveCount(0);
  const cabinetSection = content.getByRole("region", {
    name: `Synthetic cabinet ${suffix}`,
    exact: true,
  });
  const shelfSection = content.getByRole("region", {
    name: shelfName,
    exact: true,
  });
  // Every level stays mounted even when its outline branch is collapsed.
  await expect(shelfSection).toHaveCount(1);
  await tree
    .getByRole("button", {
      name: `Synthetic cabinet ${suffix}`,
      exact: true,
    })
    .click();
  await expect(cabinetRow).toHaveAttribute("aria-selected", "true");
  await expect(
    cabinetSection.getByRole("link", {
      name: `Synthetic twine ${suffix}`,
      exact: true,
    }),
  ).toHaveCount(0);
  await cabinetSection.getByRole("button", { name: /Show contents/ }).click();
  await expect(
    cabinetSection.getByRole("link", {
      name: `Synthetic twine ${suffix}`,
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    cabinetSection.getByRole("link", { name: "Open record", exact: true }),
  ).toHaveAttribute("href", `/locations/${cabinet.id}`);
  // Move the gallery itself, rather than clicking navigation, to exercise scroll tracking.
  await shelfSection.evaluate((section) => {
    const viewport = section.closest('[aria-label="Location overview"]');
    if (!(viewport instanceof HTMLElement))
      throw new Error("Missing gallery viewport");
    viewport.scrollTop +=
      section.getBoundingClientRect().top -
      viewport.getBoundingClientRect().top;
  });
  await expect(
    tree.getByRole("treeitem", { name: shelfName, exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(cabinetSection).toHaveCount(1);
  await browser.screenshot({
    path: testInfo.outputPath("location-browser-desktop.png"),
  });

  const search = browser.getByRole("searchbox", {
    name: "Find a location or item",
  });
  // Search reveals paths temporarily; selecting a result must not persist that expansion.
  await cabinetRow.focus();
  await cabinetRow.press("ArrowLeft");
  await search.fill(shelfName);
  await expect(
    tree.getByRole("button", { name: shelfName, exact: true }),
  ).toBeVisible();
  await tree.getByRole("button", { name: shelfName, exact: true }).click();
  await browser
    .getByRole("button", { name: "Clear filters", exact: true })
    .click();
  await expect(
    tree.getByRole("treeitem", { name: shelfName, exact: true }),
  ).toHaveCount(0);
  await cabinetRow
    .getByRole("button", {
      name: `Expand Synthetic cabinet ${suffix}`,
      exact: true,
    })
    .click();
  await search.fill("synthetic-no-such-location");
  await expect(
    browser.getByText("No matching locations", { exact: true }),
  ).toBeVisible();
  await browser
    .getByRole("button", { name: "Clear filters", exact: true })
    .click();
  await expect(tree).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await browser
    .getByRole("button", { name: "Show location navigation", exact: true })
    .click();
  await tree.getByRole("button", { name: shelfName, exact: true }).click();
  await expect(
    shelfSection.getByRole("heading", { name: shelfName, exact: true }),
  ).toBeInViewport();
  await expect(
    shelfSection.getByRole("link", { name: "Open record", exact: true }),
  ).toHaveAttribute("href", `/locations/${shelf.id}`);
  await browser.screenshot({
    path: testInfo.outputPath("location-browser-phone.png"),
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
