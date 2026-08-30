import { entities } from "~/entities/entities";
import { generatedBrowserRoutes } from "~/entities/generated/entity-routes.gen";
import {
  expectViewportBounded,
  failOnRouteError,
  gotoAuthenticatedPage,
} from "./e2e-helpers";
import { expect, test } from "./e2e-test";

const entityCanaries = (["product", "inventory", "expense"] as const).map(
  (entity) => ({ entity, path: generatedBrowserRoutes[entity].routes.list }),
);

const rendererCanaries = [
  { path: "/products?view=shelf", renderer: "Shelf" },
  { path: "/meals?view=calendar", renderer: "Calendar" },
  { path: "/tasks?view=board", renderer: "Board" },
  { path: "/expenses?view=analytics", renderer: "Analytics" },
];

test.describe("phone entity views", () => {
  for (const { entity, path } of entityCanaries) {
    test(`${entity} list keeps the shared phone workbench contract`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 320, height: 568 });
      await gotoAuthenticatedPage(page, path);
      await failOnRouteError(page);

      await expect(
        page.getByRole("heading", {
          level: 1,
          name: entities[entity].pluralLabel,
        }),
      ).toBeVisible({ timeout: 15000 });
      await expectViewportBounded(page);
    });
  }

  test("the canonical phone list exposes collection semantics", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await gotoAuthenticatedPage(page, "/products");

    await expect(page.getByRole("list", { name: "Products list" })).toBeVisible(
      { timeout: 15000 },
    );
  });

  test("display settings stay operable inside the phone viewport", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await gotoAuthenticatedPage(page, "/products");

    await page.getByRole("button", { name: "Display" }).click();

    const settings = page.getByRole("dialog", { name: "Display settings" });
    await expect(settings).toBeVisible();
    await expect(settings).toBeInViewport();
    const priceRow = settings.locator('[data-column-id="price"]');
    await priceRow.scrollIntoViewIfNeeded();
    await expect(priceRow).toBeInViewport();
    const horizontalBounds = await priceRow.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return {
        clientWidth: element.clientWidth,
        left: Math.round(rect.left),
        right: Math.round(rect.right),
        scrollWidth: element.scrollWidth,
        viewportWidth: window.innerWidth,
      };
    });
    expect(horizontalBounds.scrollWidth).toBeLessThanOrEqual(
      horizontalBounds.clientWidth,
    );
    expect(horizontalBounds.left).toBeGreaterThanOrEqual(0);
    expect(horizontalBounds.right).toBeLessThanOrEqual(320);
    expect(horizontalBounds.viewportWidth).toBe(320);
    await priceRow.getByRole("button", { name: "Actions for Price" }).click();
    await expect(
      page.getByRole("menuitem", { name: "Hide Price" }),
    ).toBeInViewport();
    await expectViewportBounded(page);
  });

  for (const { path, renderer } of rendererCanaries) {
    test(`${path} mounts its selected phone renderer`, async ({ page }) => {
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      await page.setViewportSize({ width: 430, height: 932 });
      await gotoAuthenticatedPage(page, path);

      await expect(
        page.getByRole("button", { name: `${renderer} view` }),
      ).toHaveAttribute("aria-pressed", "true", { timeout: 15000 });
      await expectViewportBounded(page);
      expect(pageErrors).toEqual([]);
    });
  }
});
