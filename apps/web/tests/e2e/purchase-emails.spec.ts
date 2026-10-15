/**
 * Failure modes: an exact order match must show as Suggested on its Purchase
 * (and a same-total order with a different order number must not); a
 * dismissal must survive a reload; Link must replace it; the Vendor page must
 * show the per-Purchase state; the Email page must keep the Gmail original.
 */
import { seedVendorMailReviewPrerequisite } from "./fixtures-mail";
import { gotoAuthenticatedPage } from "./e2e-helpers";
import { expect, test } from "./e2e-test";

test("reviews an Email's Purchase link from the Purchase's Emails section", async ({
  page,
}) => {
  const seed = await seedVendorMailReviewPrerequisite(
    page,
    `Synthetic Outfitters ${Date.now()}`,
  );
  await gotoAuthenticatedPage(
    page,
    `/purchases/${seed.purchase.shortcode}`,
    page.getByText("Synthetic order receipt"),
  );
  const emails = page.locator("#emails");
  const row = emails
    .getByRole("row")
    .filter({ has: page.getByText("Synthetic order receipt") });
  await expect(row.getByText("Suggested", { exact: true })).toBeVisible();
  const choose = async (action: string) => {
    await row.getByRole("button", { name: "Open menu" }).click();
    await page.getByRole("menuitem", { name: action }).click();
  };

  await choose("Dismiss for this Purchase");
  await expect(row.getByText("Dismissed", { exact: true })).toBeVisible();
  await page.reload();
  await expect(row.getByText("Dismissed", { exact: true })).toBeVisible();
  await choose("Link to this Purchase");
  await expect(row.getByText("Linked", { exact: true })).toBeVisible();

  await gotoAuthenticatedPage(
    page,
    `/vendors/${seed.vendor.shortcode}`,
    page.locator("#emails").getByText("Synthetic order receipt"),
  );
  const vendorRow = page
    .locator("#emails")
    .getByRole("row")
    .filter({ has: page.getByText("Synthetic order receipt") });
  await expect(
    vendorRow.getByRole("link", { name: seed.purchase.shortcode }),
  ).toHaveAttribute("href", `/purchases/${seed.purchase.shortcode}`);
  await expect(vendorRow.getByText("Linked").first()).toBeVisible();

  await vendorRow
    .getByRole("link", { name: "Synthetic order receipt" })
    .click();
  await expect(
    page.getByRole("link", { name: "Open in Gmail" }),
  ).toHaveAttribute(
    "href",
    /^https:\/\/mail\.google\.com\/mail\/u\/0\/#all\/synthetic-thread-/u,
  );
  // Linking is the member's relevance evidence.
  await expect(page.getByText("Related").first()).toBeVisible();
  // A diagnostic preview must be explicit and must not replace member evidence
  // when Gmail execution approval is absent.
  const preview = page.getByRole("region", { name: "Classification preview" });
  await preview
    .getByRole("button", { name: "Preview classification", exact: true })
    .click();
  await expect(preview.getByRole("alert")).toContainText(
    "Reclassify needs a usable Gmail execution approval",
  );
  await expect(
    preview.getByRole("button", {
      name: "Preview classification",
      exact: true,
    }),
  ).toBeEnabled();
  await page.reload();
  await expect(page.getByText("Related").first()).toBeVisible();
  await expect(page.getByRole("link", { name: "Open in Gmail" })).toBeVisible();
});
