import { seedVendorDisplayPrerequisite } from "./fixtures/catalog";
import {
  expectViewportBounded,
  gotoAuthenticatedPage,
} from "./support/e2e-helpers";
import { expect, test } from "./support/e2e-test";

// Browser focus restoration and canonical detail refresh cross the dialog/router boundary.
test("generic editing closes unchanged saves and restores the updated record", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const name = `Example supplier ${Date.now()}`;
  const vendor = await seedVendorDisplayPrerequisite(page, name);
  await gotoAuthenticatedPage(page, `/vendors/${vendor.id}`);
  const edit = page.getByRole("button", { name: "Edit Vendor", exact: true });
  await edit.click();
  const dialog = page.getByRole("dialog", { name: "Edit Vendor" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(dialog).toBeHidden();
  await expect(edit).toBeFocused();
  await edit.click();
  await dialog
    .getByRole("textbox", { name: "Name", exact: true })
    .fill(`${name} updated`);
  await expectViewportBounded(page);
  await page.screenshot({
    path: testInfo.outputPath("shared-editor-desktop.png"),
  });
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(dialog).toBeHidden();
  await expect(
    page.getByRole("heading", { name: `${name} updated`, exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("problems-badge")).toHaveCount(0);
});

// Regression: a form taller than the dialog clipped its footer instead of
// scrolling its body, so Save was unreachable without zooming out.
test("a tall edit dialog scrolls its fields and keeps Save in view", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 420 });
  const vendor = await seedVendorDisplayPrerequisite(
    page,
    `Example supplier ${Date.now()}`,
  );
  await gotoAuthenticatedPage(page, `/vendors/${vendor.id}`);
  await page.getByRole("button", { name: "Edit Vendor", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Edit Vendor" });
  const body = dialog.locator('[data-slot="dialog-form-body"]');
  await expect
    .poll(() => body.evaluate((el) => el.scrollHeight > el.clientHeight))
    .toBe(true);
  await expect(
    dialog.getByRole("button", { name: "Save changes" }),
  ).toBeInViewport({ ratio: 1 });
});
