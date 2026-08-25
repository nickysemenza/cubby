import { entities } from "~/entities/entities";
import { generatedBrowserRoutes } from "~/entities/generated/entity-routes.gen";
import {
  expectViewportBounded,
  failOnRouteError,
  gotoAuthenticatedPage,
} from "./e2e-helpers";
import { expect, test } from "./e2e-test";

const entityLists = Object.entries(generatedBrowserRoutes).map(
  ([entity, definition]) => ({
    entity: entity as keyof typeof generatedBrowserRoutes,
    path: definition.routes.list,
  }),
);

const rendererRoutes = [
  ["/products?view=table", "Table"],
  ["/products?view=shelf", "Shelf"],
  ["/products?view=events", "Events"],
  ["/products?view=lifecycles", "Lifecycles"],
  ["/locations?view=gallery", "Gallery"],
  ["/locations?view=table", "Table"],
  ["/locations?view=visualizations", "Visualizations"],
  ["/meals?view=calendar", "Calendar"],
  ["/meals?view=table", "Table"],
  ["/projects?view=overview", "Overview"],
  ["/projects?view=analytics", "Analytics"],
  ["/projects?view=data", "Data"],
  ["/projects?view=gallery", "Gallery"],
  ["/tasks?view=next", "Next"],
  ["/tasks?view=board", "Board"],
  ["/tasks?view=timeline", "Timeline"],
  ["/tasks?view=list", "List"],
  ["/expenses?view=ledger", "Ledger"],
  ["/expenses?view=analytics", "Analytics"],
] as const;

test.describe("desktop entity views", () => {
  for (const { entity, path } of entityLists) {
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

  for (const [path, renderer] of rendererRoutes) {
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
