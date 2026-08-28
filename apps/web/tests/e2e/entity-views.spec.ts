import { entities } from "~/entities/entities";
import { generatedBrowserRoutes } from "~/entities/generated/entity-routes.gen";
import {
  expectViewportBounded,
  failOnRouteError,
  gotoAuthenticatedPage,
} from "./e2e-helpers";
import { expect, test } from "./e2e-test";

const entityLists = Object.entries(generatedBrowserRoutes).map(
  ([entity, definition]) => {
    if (!isBrowserRouteEntity(entity)) {
      throw new Error(
        `Generated browser route has an unknown entity: ${entity}`,
      );
    }
    return { entity, path: definition.routes.list };
  },
);

function isBrowserRouteEntity(
  entity: string,
): entity is keyof typeof generatedBrowserRoutes {
  return Object.hasOwn(generatedBrowserRoutes, entity);
}

const rendererRoutes = [
  { path: "/products?view=table", renderer: "Table" },
  { path: "/products?view=shelf", renderer: "Shelf" },
  { path: "/products?view=events", renderer: "Events" },
  { path: "/products?view=lifecycles", renderer: "Lifecycles" },
  { path: "/locations?view=gallery", renderer: "Gallery" },
  { path: "/locations?view=table", renderer: "Table" },
  { path: "/locations?view=visualizations", renderer: "Visualizations" },
  { path: "/meals?view=calendar", renderer: "Calendar" },
  { path: "/meals?view=table", renderer: "Table" },
  { path: "/projects?view=overview", renderer: "Overview" },
  { path: "/projects?view=analytics", renderer: "Analytics" },
  { path: "/projects?view=data", renderer: "Data" },
  { path: "/projects?view=gallery", renderer: "Gallery" },
  { path: "/tasks?view=next", renderer: "Next" },
  { path: "/tasks?view=board", renderer: "Board" },
  { path: "/tasks?view=timeline", renderer: "Timeline" },
  { path: "/tasks?view=list", renderer: "List" },
  { path: "/expenses?view=ledger", renderer: "Ledger" },
  { path: "/expenses?view=analytics", renderer: "Analytics" },
];

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

  for (const { path, renderer } of rendererRoutes) {
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
