import { seedRecordListDisplayPrerequisite } from "./e2e-fixtures";
import { waitForAppHydration } from "./e2e-helpers";
import { expect, test } from "./e2e-test";

for (const viewport of [
  { name: "desktop", width: 1280, height: 900 },
  { name: "mobile", width: 390, height: 844 },
]) {
  test(`declared record lists retain identities, relationships and amounts on ${viewport.name}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    const name = `Record ${viewport.name} ${Date.now()}`;
    const fixture = await seedRecordListDisplayPrerequisite(page, name);
    await page.goto(`/purchases?q=${encodeURIComponent(fixture.orderId)}`);
    const purchase = page.getByRole("link", {
      name: fixture.orderId,
      exact: true,
    });
    await expect(purchase).toHaveCount(1);
    await expect(purchase).toHaveAttribute(
      "href",
      `/purchases/${fixture.purchase.id}`,
    );
    await expect(
      page.getByText("$12.34", { exact: true }).first(),
    ).toBeVisible();
    if (viewport.name === "desktop") {
      await expect(
        page.getByRole("button", {
          name: "Reorder reconciliation column",
          exact: true,
        }),
      ).toHaveCount(1);
      await expect(
        page.getByText(`${name} purchase notes`, { exact: true }),
      ).toBeVisible();
    }
    await page.goto(`/expenses?q=${encodeURIComponent(`${name} expense`)}`);
    await expect(
      page.getByRole("link", { name: `${name} expense`, exact: true }),
    ).toHaveCount(1);
    await expect(
      page.getByText("$12.34", { exact: true }).first(),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: `${name} product`, exact: true }).first(),
    ).toHaveAttribute("href", `/products/${fixture.product.id}`);
    if (viewport.name === "desktop") {
      await expect(
        page.getByRole("columnheader").filter({
          has: page.getByRole("button", {
            name: "Reorder vendor column",
            exact: true,
          }),
        }),
      ).toContainText("Purchase");
    }
    // The parent relationship is visible in both table rows and mobile cards;
    // Children remains hidden by default in the existing display preferences.
    await page.goto(`/locations?name=${encodeURIComponent(`${name} shelf`)}`);
    await waitForAppHydration(page);
    await page.getByRole("button", { name: "Table view", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Table view", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    if (viewport.name === "desktop") {
      await expect(
        page.getByRole("columnheader").filter({
          has: page.getByRole("button", {
            name: "Reorder name column",
            exact: true,
          }),
        }),
      ).toContainText("Name");
    }
    await expect(
      page.getByRole("link", { name: `${name} room · room`, exact: true }),
    ).toHaveAttribute("href", `/locations/${fixture.location.id}`);
    await expect(
      page.getByRole("link", { name: `${name} shelf`, exact: true }),
    ).toHaveAttribute("href", `/locations/${fixture.child.id}`);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(viewport.width + 1);
    await page.screenshot({
      path: testInfo.outputPath(`records-${viewport.name}.png`),
    });
  });
}
