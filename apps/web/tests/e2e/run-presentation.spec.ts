import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { eq } from "drizzle-orm";
import { imageProcessingJob } from "~/server/db/image-processing-schema";
import { getDb } from "~/server/repo/database-helpers";

import { gotoAuthenticatedPage } from "./e2e-helpers";
import { expect, test } from "./e2e-test";
import { fixtureUserId, getFixtureDb } from "./fixtures-core";
import { seedActivityHistory } from "./fixtures-photos";

// A successful image result must not look queued; skipped work must explain the actual outcome.
test("image jobs show completed status and an Apple skip reason", async ({
  page,
}) => {
  const sample = await seedActivityHistory(page, "Synthetic image outcome");
  const db = getDb(getFixtureDb());
  await db
    .update(imageProcessingJob)
    .set({ state: "ready", lastError: null, completedAt: new Date() })
    .where(eq(imageProcessingJob.shortcode, sample.jobId));
  await db
    .update(imageProcessingJob)
    .set({ state: "skipped", lastError: "no_subject", completedAt: new Date() })
    .where(eq(imageProcessingJob.shortcode, sample.standaloneJobId));
  await gotoAuthenticatedPage(page, `/image-jobs?imageId=${sample.imageId}`);
  const table = page.getByRole("table");
  const completed = table
    .getByRole("row")
    .filter({ hasText: "Image description" });
  await expect(
    completed.getByText("Completed", { exact: true }),
  ).toHaveAttribute("data-variant", "positive");
  const skipped = table.getByRole("row").filter({ hasText: "Subject lift" });
  await expect(skipped).toContainText("Apple found no foreground subject.");
});

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
  await page
    .getByRole("heading", { level: 2, name: "Work", exact: true })
    .scrollIntoViewIfNeeded();
  const row = page
    .getByRole("table", { name: "Runs", exact: true })
    .getByRole("row")
    .filter({ hasText: "Synthetic store login" });
  await expect(row).toHaveCount(1);
  await expect(row).not.toContainText(account.shortcode);
  await expect(
    row.getByRole("link", { name: account.label, exact: true }),
  ).toHaveAttribute("href", `/vendor-accounts/${account.shortcode}`);
  await expect(row.getByText("100", { exact: true })).toBeVisible();
  await row.hover();
  await row
    .getByRole("button", { name: "How quality is determined", exact: true })
    .click();
  await expect(
    page.getByText("Actor attributed", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Timeline recorded", { exact: true }),
  ).toBeVisible();

  await gotoAuthenticatedPage(page, "/runs");
  const listRow = page
    .getByRole("row")
    .filter({ hasText: "Synthetic reference vendor" });
  await expect(listRow.getByText("100", { exact: true })).toBeVisible();
});
