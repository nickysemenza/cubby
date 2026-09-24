import { seedVendorDisplayPrerequisite } from "./e2e-fixtures";
import { expectViewportBounded, gotoAuthenticatedPage } from "./e2e-helpers";
import { expect, test } from "./e2e-test";

// Browser focus restoration and canonical detail refresh cross the dialog/router boundary.
test("generic editing closes unchanged saves and restores the updated record", async ({
  page,
}) => {
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
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(dialog).toBeHidden();
  await expect(
    page.getByRole("heading", { name: `${name} updated`, exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("problems-badge")).toHaveCount(0);
});
