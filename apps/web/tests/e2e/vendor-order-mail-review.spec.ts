import { seedVendorMailReviewPrerequisite } from "./e2e-fixtures";
import { gotoAuthenticatedPage } from "./e2e-helpers";
import { expect, test } from "./e2e-test";

test("reviews a vendor email match and shows the linked conversation on Purchase", async ({
  page,
}) => {
  const seed = await seedVendorMailReviewPrerequisite(
    page,
    `Synthetic Outfitters ${Date.now()}`,
  );
  await gotoAuthenticatedPage(
    page,
    `/vendors/${seed.vendor.shortcode}`,
    page.getByText("Synthetic order receipt"),
  );
  await expect(
    page.getByRole("button", { name: "Search Gmail now" }),
  ).toBeVisible();
  const receipt = page
    .getByRole("article")
    .filter({ hasText: "Synthetic order receipt" });
  await expect(
    receipt.getByRole("link", { name: "SYN-ORDER-1001" }),
  ).toBeVisible();
  await receipt.getByRole("button", { name: "Dismiss" }).click();
  await expect(receipt.getByText("dismissed", { exact: true })).toBeVisible();
  await page.reload();
  await expect(receipt.getByText("dismissed", { exact: true })).toBeVisible();
  await receipt.getByRole("button", { name: "Link" }).click();
  await expect(receipt.getByText("linked", { exact: true })).toBeVisible();

  await gotoAuthenticatedPage(
    page,
    `/purchases/${seed.purchase.shortcode}`,
    page.getByText("Synthetic order receipt"),
  );
  await expect(page.getByText("Synthetic order receipt")).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Open Gmail conversation" }),
  ).toBeVisible();
});
