import { seedVendorDisplayPrerequisite } from "./e2e-fixtures";
import { expect, test } from "./e2e-test";

for (const viewport of [
  { name: "desktop", width: 1280, height: 900 },
  { name: "mobile", width: 390, height: 844 },
]) {
  test(`declared vendor columns preserve identity and details on ${viewport.name}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    const name = `Vendor display ${viewport.name} ${Date.now()}`;
    const vendor = await seedVendorDisplayPrerequisite(page, name);
    await page.goto(`/vendors?q=${encodeURIComponent(name)}`);
    const identity = page.getByRole("link", { name, exact: true });
    await expect(identity).toHaveCount(1);
    await expect(identity).toHaveAttribute("href", `/vendors/${vendor.id}`);
    if (viewport.name === "desktop") {
      await expect(
        page.getByText(`${name} notes`, { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("columnheader").filter({
          has: page.getByRole("button", {
            name: "Reorder name column",
            exact: true,
          }),
        }),
      ).toHaveCount(1);
    }
    await identity.click();
    await expect(
      page.getByText(`${name} notes`, { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("link").filter({ hasText: "example.com" }).first(),
    ).toHaveAttribute("href", "https://example.com");
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(viewport.width + 1);
    await page
      .getByText(`${name} notes`, { exact: true })
      .scrollIntoViewIfNeeded();
    await page.screenshot({
      animations: "disabled",
      path: testInfo.outputPath(`vendor-${viewport.name}.png`),
    });
  });
}
