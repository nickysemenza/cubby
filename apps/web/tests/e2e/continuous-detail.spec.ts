import {
  seedProductPrerequisite,
  seedProductCategoryPrerequisite,
} from "./fixtures-catalog";
import { createEntityFixture, seedConcurrently } from "./fixtures-core";
import {
  attachProductImagePrerequisite,
  seedImagePrerequisite,
} from "./fixtures-photos";
import { expectViewportBounded, gotoAuthenticatedPage } from "./e2e-helpers";
import { expect, test } from "./e2e-test";

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
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await gotoAuthenticatedPage(page, `/products/${product.id}`);
    const header = page.getByTestId("detail-spec-plate");
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
    if (width !== 1024)
      await page.screenshot({
        path: test.info().outputPath(`dense-header-${width}.png`),
      });
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
    if (width !== 1024)
      await page.screenshot({
        path: test.info().outputPath(`dense-editor-${width}.png`),
      });
    await editor.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(editor).toBeHidden();
    await expectViewportBounded(page);
  }
  const owner = await createEntityFixture(page, "ledgerParty", {
    name: "Example wardrobe owner",
    kind: "member",
  });
  await gotoAuthenticatedPage(page, `/ledger-parties/${owner.id}`);
  await page.getByRole("button", { name: "More actions", exact: true }).click();
  const wardrobe = page
    .getByRole("dialog", { name: "More actions", exact: true })
    .getByRole("link", { name: "Open wardrobe", exact: true });
  await expect(wardrobe).toHaveAttribute(
    "href",
    `/collections/wardrobe/${owner.id}`,
  );
  await page.keyboard.press("Escape");
  await seedConcurrently(
    Array.from({ length: 18 }, (_, index) => index),
    (index) =>
      seedProductPrerequisite(page, {
        name: `Example household item ${String(index + 1).padStart(2, "0")}`,
        manufacturer: "Example maker",
        categoryId: category.id,
      }),
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoAuthenticatedPage(page, "/products");
  await expect(page.getByRole("link", { name, exact: true })).toBeVisible();
  const row = page
    .getByRole("row")
    .filter({ has: page.getByRole("link", { name, exact: true }) });
  await expect(
    row.getByRole("link", { name: "Example essentials", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath("dense-list-1440.png"),
  });
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
        .getByRole("link", { name: "History", exact: true })
        .click();
    } else {
      await page.getByRole("button", { name: /Jump to:/ }).click();
      await expect(
        page.getByRole("menuitem", { name: "Plantings", exact: true }),
      ).toHaveAccessibleDescription("0");
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
    await page.screenshot({
      path: testInfo.outputPath(`continuous-detail-${width}.png`),
    });
  });
}
