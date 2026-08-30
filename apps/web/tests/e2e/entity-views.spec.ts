import { entities } from "~/entities/entities";
import { generatedBrowserRoutes } from "~/entities/generated/entity-routes.gen";
import {
  expectViewportBounded,
  failOnRouteError,
  gotoAuthenticatedPage,
} from "./e2e-helpers";
import { expect, test } from "./e2e-test";

const entityCanaries = (
  ["product", "financialTransaction", "recipe"] as const
).map((entity) => ({
  entity,
  path: generatedBrowserRoutes[entity].routes.list,
}));

const rendererCanaries = [
  { path: "/products?view=lifecycles", renderer: "Lifecycles" },
  { path: "/locations?view=visualizations", renderer: "Visualizations" },
  { path: "/meals?view=calendar", renderer: "Calendar" },
  { path: "/projects?view=analytics", renderer: "Analytics" },
  { path: "/tasks?view=board", renderer: "Board" },
  { path: "/expenses?view=ledger", renderer: "Ledger" },
];

test.describe("desktop entity views", () => {
  for (const { entity, path } of entityCanaries) {
    test(`${entity} list keeps the shared desktop workbench contract`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
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

  test("the canonical desktop table keeps its collection semantics", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoAuthenticatedPage(page, "/products");

    await expect(
      page.getByRole("table", { name: "Products table" }),
    ).toBeVisible({ timeout: 15000 });
  });

  for (const { path, renderer } of rendererCanaries) {
    test(`${path} mounts its selected desktop renderer`, async ({ page }) => {
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      await page.setViewportSize({ width: 1440, height: 900 });
      await gotoAuthenticatedPage(page, path);

      await expect(
        page.getByRole("button", { name: `${renderer} view` }),
      ).toHaveAttribute("aria-pressed", "true", { timeout: 15000 });
      await expectViewportBounded(page);
      expect(pageErrors).toEqual([]);
    });
  }

  test("the compact landscape breakpoint stays document-bounded", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 844, height: 390 });
    await gotoAuthenticatedPage(page, "/projects?view=data");
    await expectViewportBounded(page);
  });
});
