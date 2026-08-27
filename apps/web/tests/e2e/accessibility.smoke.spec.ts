import AxeBuilder from "@axe-core/playwright";
import {
  seedFinancialAccountPrerequisite,
  seedImagePrerequisite,
  seedLocationPrerequisite,
  seedProductPrerequisite,
} from "./e2e-fixtures";
import { gotoAuthenticatedPage } from "./e2e-helpers";
import { expect, test } from "./e2e-test";

test("representative authenticated pages have no serious Axe violations", async ({
  page,
}) => {
  const assertAccessible = async () => {
    // Detail cards stagger their fade-in. Freeze motion before sampling so Axe
    // evaluates the settled colors instead of a transient translucent frame.
    await page.addStyleTag({
      content:
        "*, *::before, *::after { animation: none !important; transition: none !important; }",
    });
    const results = await new AxeBuilder({ page }).analyze();
    const serious = results.violations
      .filter(({ impact }) => impact === "serious" || impact === "critical")
      .map(({ id, nodes }) => ({
        id,
        targets: nodes.map((node) => node.target),
      }));
    expect(serious).toEqual([]);
  };

  await gotoAuthenticatedPage(page, "/products");
  await assertAccessible();
  const product = await seedProductPrerequisite(page, {
    name: "Axe accessibility product",
  });
  const location = await seedLocationPrerequisite(
    page,
    "Axe accessibility location",
  );
  const account = await seedFinancialAccountPrerequisite(
    page,
    "Axe accessibility cash account",
  );
  const image = await seedImagePrerequisite("axe-accessibility-image");
  await gotoAuthenticatedPage(page, "/");
  await assertAccessible();

  await page.goto("/recipes");
  await assertAccessible();

  await page.goto("/financial-transactions");
  await assertAccessible();

  await page.goto("/products/new");
  await assertAccessible();

  await page.goto(`/products/${product.id}`);
  await assertAccessible();

  await page.goto("/locations");
  await assertAccessible();
  await page.goto(`/locations/${location.id}`);
  await assertAccessible();

  await page.goto("/financial-accounts");
  await assertAccessible();
  await page.goto(`/financial-accounts/${account.id}`);
  await assertAccessible();

  await page.goto("/images");
  await assertAccessible();
  await page.goto(`/images/${image.id}`);
  await assertAccessible();

  await page.goto("/labels");
  await page.getByRole("button", { name: "Add", exact: true }).first().click();
  await expect(
    page.getByRole("textbox", { name: "Search locations" }),
  ).toBeFocused();
  await assertAccessible();
});
