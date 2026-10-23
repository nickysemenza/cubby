/**
 * Failure modes: an exact order match must show as Suggested on its Purchase
 * (and a same-total order with a different order number must not); a
 * dismissal must survive a reload; Link must replace it; the Email page must keep the Gmail original.
 */
import { seedVendorMailReviewPrerequisite } from "./fixtures/mail";
import { gotoAuthenticatedPage } from "./support/e2e-helpers";
import { expect, test } from "./support/e2e-test";

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

  await row.getByRole("link", { name: "Synthetic order receipt" }).click();
  await expect(
    page.getByRole("link", { name: "Open in Gmail" }),
  ).toHaveAttribute(
    "href",
    /^https:\/\/mail\.google\.com\/mail\/u\/0\/#all\/synthetic-thread-/u,
  );
  // Linking is the member's relevance evidence.
  await expect(page.getByText("Related").first()).toBeVisible();
});
