import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import { gotoAuthenticatedPage } from "./e2e-helpers";
import { expect, test } from "./e2e-test";
import { fixtureUserId, getFixtureDb } from "./fixtures-core";

test("related Runs show account labels and shared quality", async ({
  page,
}) => {
  const db = getFixtureDb();
  const userId = await fixtureUserId(page);
  const vendor = await insertWithShortcode(db, "vendor", {
    name: "Synthetic reference vendor",
  });
  const party = await insertWithShortcode(db, "ledgerParty", {
    name: "Fixture agent",
    kind: "guest",
  });
  const account = await insertWithShortcode(db, "vendorAccount", {
    vendorId: vendor.id,
    ledgerPartyId: party.id,
    label: "Synthetic store login",
  });
  await insertWithShortcode(db, "run", {
    actorUserId: userId,
    actorName: "Fixture agent",
    actorEmail: "agent@example.test",
    purpose: "background",
    trigger: "manual",
    status: "completed",
    vendorId: vendor.id,
    vendorAccountId: account.id,
    startedAt: new Date("2026-09-01T10:00:00Z"),
    endedAt: new Date("2026-09-01T10:01:00Z"),
  });
  await gotoAuthenticatedPage(page, `/vendors/${vendor.shortcode}`);
  await page.getByRole("tab", { name: "Overview", exact: true }).click();
  const row = page
    .getByRole("table", { name: "Runs", exact: true })
    .getByRole("row")
    .filter({ hasText: "Synthetic store login" });
  await expect(row).toHaveCount(1);
  await expect(row).not.toContainText(account.shortcode);
  await expect(
    row.getByRole("link", { name: account.label, exact: true }),
  ).toHaveAttribute("href", `/vendor-accounts/${account.shortcode}`);
  await expect(row.getByText("100/100", { exact: true })).toBeVisible();
  await row
    .getByRole("button", { name: "How quality is determined", exact: true })
    .click();
  await page.getByText("2 satisfied checks", { exact: true }).click();
  await expect(
    page.getByText("Actor attribution", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Run timeline", { exact: true })).toBeVisible();

  await gotoAuthenticatedPage(page, "/runs");
  const listRow = page
    .getByRole("row")
    .filter({ hasText: "Synthetic reference vendor" });
  await expect(listRow.getByText("100/100", { exact: true })).toBeVisible();
});
