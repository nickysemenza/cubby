import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { createProduct } from "./e2e-helpers";

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

  await page.goto("/products");
  await assertAccessible();

  await page.goto("/products/new");
  await assertAccessible();

  await createProduct(page, `Axe Product ${Date.now()}`);
  await assertAccessible();

  await page.goto("/labels");
  await page.getByRole("button", { name: "Add", exact: true }).first().click();
  await expect(
    page.getByRole("textbox", { name: "Search locations" }),
  ).toBeFocused();
  await assertAccessible();
});
