import {
  seedProductPrerequisite,
  seedProductCategoryPrerequisite,
} from "./fixtures/catalog";
import { createEntityFixture } from "./fixtures/core";
import {
  householdDateTime,
  householdDaysFromNow,
  householdLocalDate,
} from "~/lib/household-date";
import {
  attachProductImagePrerequisite,
  seedImagePrerequisite,
} from "./fixtures/photos";
import {
  expectViewportBounded,
  gotoAuthenticatedPage,
} from "./support/e2e-helpers";
import { expect, test } from "./support/e2e-test";

// Calendar age must survive an evening view on the real record timeline.
test("activity uses calendar days on an evening view", async ({ page }) => {
  const today = householdLocalDate();
  const yesterday = householdDaysFromNow(-1);
  await page.clock.setFixedTime(householdDateTime(today, 23 * 60));
  const product = await seedProductPrerequisite(page, {
    name: `Synthetic chart and activity ${Date.now()}`,
  });
  await createEntityFixture(page, "expense", {
    name: "Synthetic yesterday expense",
    productId: product.id,
    cost: 42,
    date: yesterday,
    costType: "materials",
    trade: "other",
  });
  await gotoAuthenticatedPage(page, `/products/${product.id}`);
  await expect(
    page.getByTestId("detail-activity").getByText("yesterday", { exact: true }),
  ).toBeVisible();
});

// Long record identity and many actions must never compete for the same pixels.
// Overflow must retain registry dialogs and lazy workflow controls on every width.
test("dense record header preserves identity, actions, and the editor", async ({
  page,
  e2eRuntime,
}) => {
  const name =
    "Canvas utility jacket with a deliberately long product name for constrained desktop record headers";
  const category = await seedProductCategoryPrerequisite(page, {
    name: "Example essentials",
  });
  const product = await seedProductPrerequisite(page, {
    name,
    categoryId: category.id,
  });
  const image = await seedImagePrerequisite(
    "example-record-cover",
    e2eRuntime.objectStorageUrl,
  );
  await attachProductImagePrerequisite(page, image.id, product.id, "item");
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoAuthenticatedPage(page, `/products/${product.id}`);
  const header = page.getByTestId("detail-spec-plate");
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const title = header.getByRole("heading", { level: 1 });
    await expect(title).toHaveText(name);
    await expect(
      header.getByRole("button", { name: "Edit Product" }),
    ).toBeVisible();
    await expect(
      header.getByRole("button", { name: "Add to inventory", exact: true }),
    ).toBeVisible();
    const geometry = await header.evaluate((element) => {
      const heading = element.querySelector("h1")!.getBoundingClientRect();
      const actions = [...element.querySelectorAll("button")]
        .filter((button) => button.getAttribute("title") !== "Copy shortcode")
        .map((button) => button.getBoundingClientRect())
        .filter((rect) => rect.width > 0 && rect.height > 0);
      return {
        titleWidth: heading.width,
        overlaps: actions.some(
          (rect) =>
            rect.left < heading.right &&
            rect.right > heading.left &&
            rect.top < heading.bottom &&
            rect.bottom > heading.top,
        ),
      };
    });
    expect(geometry.titleWidth).toBeGreaterThan(200);
    expect(geometry.overlaps).toBe(false);
    const cover = header.getByRole("img", { name: "example-record-cover.png" });
    await expect
      .poll(() =>
        cover.evaluate(
          (node) => node instanceof HTMLImageElement && node.naturalWidth > 0,
        ),
      )
      .toBe(true);
    if (width === 1440)
      await expect(
        page.getByRole("navigation", { name: "Section index" }),
      ).toBeVisible();

    await expectViewportBounded(page);
  }
  // The shared controls are visible at every width; drive their dialogs once
  // at the narrowest viewport instead of repeating the same registry actions.
  await header
    .getByRole("button", { name: "More actions", exact: true })
    .click();
  const overflow = page.getByRole("dialog", {
    name: "More actions",
    exact: true,
  });
  await expect(
    overflow.getByRole("button", { name: "Copy codes", exact: true }),
  ).toBeVisible();
  await expect(
    overflow.getByRole("button", { name: "Discard...", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(overflow).toBeHidden();
  await header.getByRole("button", { name: "Edit Product" }).click();
  const editor = page.getByRole("dialog", {
    name: "Edit product",
    exact: true,
  });
  await expect(editor).toBeVisible();
  await expect(
    editor.getByRole("textbox", { name: "Name", exact: true }),
  ).toHaveValue(name);

  await editor.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(editor).toBeHidden();
});

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
    await expect(emptySection.getByText("0", { exact: true })).toBeVisible();
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
      ).toContainText("0");
      await contents
        .getByRole("link", { name: "Activity", exact: true })
        .click();
    } else {
      await page.getByRole("button", { name: /Jump to:/ }).click();
      await expect(
        page.getByRole("menuitem", { name: "Plantings", exact: true }),
      ).toHaveAccessibleDescription("0");
      await page
        .getByRole("menuitem", { name: "Activity", exact: true })
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
          .getByRole("link", { name: "Activity", exact: true }),
      ).toHaveAttribute("aria-current", "location");
    } else {
      await expect(
        page.getByRole("button", { name: "Jump to: Activity" }),
      ).toBeVisible();
    }
    await expect(
      page.locator("#documents").getByText("0", { exact: true }),
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
  });
}
