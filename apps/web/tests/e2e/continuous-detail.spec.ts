import { seedProductPrerequisite } from "./fixtures-catalog";
import { expectViewportBounded, gotoAuthenticatedPage } from "./e2e-helpers";
import { expect, test } from "./e2e-test";

// Regressions: empty declared sections disappear; a hash selects a hidden view;
// jump navigation replaces history; scrolling never updates the current entry.
for (const width of [1440, 390]) {
  test(`continuous record contents retain empty sections and jump targets at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const product = await seedProductPrerequisite(page, {
      name: `E2E contents ${testInfo.workerIndex}-${Date.now()}`,
    });
    await gotoAuthenticatedPage(page, `/products/${product.id}#plantings`);
    const emptySection = page.locator("#plantings");
    await expect(emptySection).toBeVisible();
    await expect(
      emptySection.getByText("Empty", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Work", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Activity", exact: true }),
    ).toBeVisible();
    if (width >= 800) {
      const contents = page.getByRole("navigation", { name: "Section index" });
      await expect(contents).toBeVisible();
      await expect(
        contents.getByRole("link", { name: "Plantings", exact: true }),
      ).toContainText("Empty");
      await contents
        .getByRole("link", { name: "History", exact: true })
        .click();
    } else {
      await page.getByRole("button", { name: /Jump to:/ }).click();
      await expect(
        page.getByRole("menuitem", { name: "Plantings", exact: true }),
      ).toHaveAccessibleDescription("Empty");
      await page
        .getByRole("menuitem", { name: "History", exact: true })
        .click();
    }
    await expect(page).toHaveURL(/#history$/u);
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.id))
      .toBe("history");
    if (width >= 800) {
      await expect(
        page
          .getByRole("navigation", { name: "Section index" })
          .getByRole("link", { name: "History", exact: true }),
      ).toHaveAttribute("aria-current", "location");
    } else {
      await expect(
        page.getByRole("button", { name: "Jump to: History" }),
      ).toBeVisible();
    }
    await expect(
      page.locator("#documents").getByText("Empty", { exact: true }),
    ).toBeVisible();
    await expect(emptySection).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(/#plantings$/u);
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.id))
      .toBe("plantings");
    await page
      .locator("#tasks")
      .evaluate((element) => element.scrollIntoView({ block: "start" }));
    if (width >= 800) {
      await expect(
        page
          .getByRole("navigation", { name: "Section index" })
          .getByRole("link", { name: "Tasks", exact: true }),
      ).toHaveAttribute("aria-current", "location");
    } else {
      await expect(
        page.getByRole("button", { name: /Jump to: Tasks/ }),
      ).toBeVisible();
    }
    await expect(page).toHaveURL(/#plantings$/u);
    await expectViewportBounded(page);
    await page.screenshot({
      path: testInfo.outputPath(`continuous-detail-${width}.png`),
    });
  });
}
