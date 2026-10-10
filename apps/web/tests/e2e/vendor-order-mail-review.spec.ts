import * as schema from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";

import { getFixtureDb } from "./fixtures-core";
import { seedVendorMailReviewPrerequisite } from "./fixtures-mail";
import { gotoAuthenticatedPage } from "./e2e-helpers";
import { expect, test } from "./e2e-test";

test("reviews a vendor email match through the generic report and shows the linked original on Purchase", async ({
  page,
}) => {
  const seed = await seedVendorMailReviewPrerequisite(
    page,
    `Synthetic Outfitters ${Date.now()}`,
  );
  await getDb(getFixtureDb())
    .insert(schema.mailboxMessage)
    .values({
      ledgerPartyId: seed.mail.ledgerPartyId,
      mailboxId: seed.mail.mailboxId,
      messageId: seed.mail.messageId,
      orderMailId: seed.mail.id,
      checksum: seed.mail.rawChecksum,
      classification: "uncertain",
      classificationVersion: "synthetic-review/v1",
      status: "blocked",
      updatedAt: new Date("2026-09-11T12:00:00Z"),
    });
  await gotoAuthenticatedPage(
    page,
    `/vendors/${seed.vendor.shortcode}`,
    page.getByText("Synthetic order receipt"),
  );
  await expect(
    page.getByText("Classification: uncertain", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Processing: blocked", { exact: true }),
  ).toBeVisible();
  const exactRow = page.getByRole("listitem").filter({
    has: page.locator(`a[href="/purchases/${seed.purchase.shortcode}"]`),
  });
  await expect(
    exactRow.getByRole("link", {
      name: seed.purchase.shortcode,
      exact: true,
    }),
  ).toHaveAttribute("href", `/purchases/${seed.purchase.shortcode}`);
  await expect(
    exactRow.getByText("Suggested match", { exact: true }),
  ).toBeVisible();
  await exactRow
    .getByRole("button", { name: "Dismiss suggestion", exact: true })
    .click();
  await expect(exactRow.getByText("Dismissed", { exact: true })).toBeVisible();
  await page.reload();
  await expect(exactRow.getByText("Dismissed", { exact: true })).toBeVisible();
  await exactRow
    .getByRole("button", { name: "Link Purchase", exact: true })
    .click();
  await expect(exactRow.getByText("Linked", { exact: true })).toBeVisible();
  await gotoAuthenticatedPage(
    page,
    `/purchases/${seed.purchase.shortcode}`,
    page.getByText("Synthetic order receipt"),
  );
  await expect(
    page.getByRole("link", { name: "Open Gmail original" }),
  ).toHaveAttribute(
    "href",
    /^https:\/\/mail\.google\.com\/mail\/u\/0\/#all\/synthetic-thread-/u,
  );
  await expect(page.getByText("Linked", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Processing: blocked", { exact: true }),
  ).toBeVisible();
});
