import { entities } from "~/entity/entities";

import { expect, test } from "./hmr-test";

const recordLink = (prefix: string) =>
  `main a[href^="${prefix}/"]:not([href$="/new"])`;

test.beforeEach(({ page }) => {
  page.on("pageerror", (error) => {
    throw error;
  });
});

for (const entity of ["task", "product"] as const) {
  test(`${entity} preview renders each list state from schema fixtures`, async ({
    page,
  }) => {
    const list = entities[entity].routes.list;
    const open = (state: "error" | "empty" | "edge") =>
      page
        .getByRole("group", { name: "Preview state" })
        .getByRole("button", {
          name: `${{ error: "Error", empty: "Empty", edge: "Edge rows" }[state]} view`,
          exact: true,
        })
        .click();

    await page.goto(`/__dev/preview?entity=${entity}&state=loading`, {
      waitUntil: "domcontentloaded",
    });
    await expect(
      page.getByRole("main").getByRole("status", { name: "Loading" }),
    ).toBeVisible();
    await expect(page.locator(recordLink(list))).toHaveCount(0);

    // Household error surfaces show raw diagnostics, never a softened message.
    await open("error");
    await expect(page.getByRole("main").getByRole("alert")).toContainText(
      "SQLSTATE",
    );

    await open("empty");
    await expect(page.locator('main [data-slot="empty"]')).toBeVisible();
    await expect(page.locator(recordLink(list))).toHaveCount(0);

    await open("edge");
    const links = page.locator(recordLink(list));
    await expect(links.first()).toBeVisible();
    expect(await links.count()).toBeGreaterThanOrEqual(3);
    const names = await links.allTextContents();
    expect(names.some((name) => name.length > 100)).toBe(true);
    // A long unbroken title wraps or truncates inside the list, not the page.
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  });
}

test("an owned fixture reaches the HMR list and cleanup removes it", async ({
  page,
  owned,
}) => {
  const name = owned.name("task");
  await owned.create("task", { name, trade: "other" });
  const search = `/tasks?searchQuery=${encodeURIComponent(name)}`;
  await page.goto(search);
  const link = page.getByRole("link", { name, exact: true });
  await expect(link).toBeVisible();

  await owned.cleanup();
  await page.goto(search);
  await expect(page.locator('main [data-slot="empty"]')).toBeVisible();
  await expect(link).toHaveCount(0);
});
