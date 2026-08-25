import { entities } from "~/entities/entities";
import { generatedBrowserRoutes } from "~/entities/generated/entity-routes.gen";
import { expectViewportBounded, gotoAuthenticatedPage } from "./e2e-helpers";
import { expect, test } from "./e2e-test";

const entityLists = Object.entries(generatedBrowserRoutes).map(
  ([entity, definition]) => ({
    entity: entity as keyof typeof generatedBrowserRoutes,
    path: definition.routes.list,
  }),
);

test.describe("phone entity views", () => {
  for (const { entity, path } of entityLists) {
    test(`${entity} list keeps the shared phone workbench contract`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 320, height: 568 });
      await gotoAuthenticatedPage(page, path);

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
});
