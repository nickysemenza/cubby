import {
  seedActivityHistory,
  seedPagedActivityHistory,
  seedActiveResearchHistory,
  setResearchHistoryStatus,
  seedMailImportReportRun,
} from "./fixtures-photos";
import {
  expectViewportBounded,
  gotoAuthenticatedPage,
  uniqueName,
} from "./e2e-helpers";
import { expect, test } from "./e2e-test";

test("Runs list in the generic table, filter to attention, and open the record inspector", async ({
  page,
}) => {
  const sample = await seedActiveResearchHistory(
    page,
    uniqueName(test.info(), "Generic runs"),
  );
  await setResearchHistoryStatus(
    sample.childId,
    "failed",
    "Synthetic retailer response: 503 source unavailable",
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoAuthenticatedPage(page, `/runs?vendorId=${sample.vendorId}`);
  const table = page.getByRole("table");
  const status = (name: string) =>
    table.getByRole("cell", { name, exact: true });
  await expect(status("Completed")).toHaveCount(1);
  await expect(status("Failed")).toHaveCount(1);
  await gotoAuthenticatedPage(
    page,
    `/runs?vendorId=${sample.vendorId}&status=failed`,
  );
  await expect(status("Completed")).toHaveCount(0);
  await status("Failed").click();
  const inspector = page.getByRole("complementary", { name: "Run inspector" });
  await expect(inspector).toContainText(sample.childId);
  await expect(
    inspector.getByRole("button", { name: "Open full run details" }),
  ).toBeVisible();
  await inspector
    .getByRole("button", { name: "Close inspector", exact: true })
    .click();
  await expect(inspector).toHaveCount(0);
  await expectViewportBounded(page);
});

test("Mail import exposes its persisted counts in the shared Run detail", async ({
  page,
}) => {
  const id = await seedMailImportReportRun(
    page,
    uniqueName(test.info(), "Mail report"),
  );
  await gotoAuthenticatedPage(page, `/runs/${id}`);
  await expect(
    page.getByRole("heading", { name: "Counts", exact: true }),
  ).toBeVisible();
  const counts = page.locator("#import-stats");
  await expect(
    counts.getByText("Targets", { exact: true }).locator(".."),
  ).toHaveText("Targets1");
  await expect(
    counts.getByText("Verified", { exact: true }).locator(".."),
  ).toHaveText("Verified1");
  await expect(
    page.locator("#import-targets").getByRole("link", { name: /^EML-/ }),
  ).toHaveCount(1);
  await page
    .getByRole("heading", { level: 2, name: "Work", exact: true })
    .scrollIntoViewIfNeeded();
  await expect(
    page.getByRole("heading", { name: "Purchases changed", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("heading", { level: 2, name: "Evidence", exact: true })
    .scrollIntoViewIfNeeded();
  await expect(
    page.getByRole("heading", { name: "Run progress", exact: true }),
  ).toBeVisible();
});

/**
 * An Image job lists through the generic table filtered by its submission
 * membership, and its detail draws every attempt (with diagnostics) and event
 * from the server's report.
 */
test("Image jobs list by submission and show every attempt and event", async ({
  page,
}) => {
  const name = uniqueName(test.info(), "Paged history");
  const sample = await seedPagedActivityHistory(name, 22);
  await page.setViewportSize({ width: 1440, height: 2400 });
  await gotoAuthenticatedPage(
    page,
    `/image-jobs?submissionId=${sample.submissionId}`,
  );
  const table = page.getByRole("table");
  const filenamePattern = new RegExp(`${name} (\\d{2})\\.png`, "g");
  const listedJobs = async () => {
    const text = (await table.textContent()) ?? "";
    return new Set(Array.from(text.matchAll(filenamePattern), (m) => m[1]))
      .size;
  };
  await expect.poll(listedJobs).toBe(22);

  await gotoAuthenticatedPage(page, `/image-jobs/${sample.newestJobId}`);
  const attempts = page.locator("#attempts");
  await expect(attempts.getByText("Attempt #22", { exact: true })).toBeVisible();
  await expect(attempts.getByText("Attempt #1", { exact: true })).toBeVisible();
  await expect(attempts.getByText(/^synthetic\.step\.\d{2}$/)).toHaveCount(22);
});

test("Image jobs open in the generic detail and their Run's section, while Activity shows changes", async ({
  page,
}) => {
  const sample = await seedActivityHistory(
    page,
    `Synthetic history ${Date.now()}`,
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoAuthenticatedPage(page, `/image-jobs?imageId=${sample.imageId}`);
  const table = page.getByRole("table");
  await expect(table).toContainText(`Subject lift · ${sample.filename}`);
  await expect(table).toContainText(`Image description · ${sample.filename}`);

  await gotoAuthenticatedPage(page, `/image-jobs/${sample.jobId}`);
  const attempts = page.locator("#attempts");
  await attempts
    .getByText("Diagnostics and result", { exact: true })
    .first()
    .click();
  await expect(attempts.getByText(/synthetic-vision/)).toBeVisible();

  // The requesting Run lists the job through the generic relation.
  await gotoAuthenticatedPage(page, `/runs/${sample.runId}`);
  await expect(page.getByText(sample.jobId).first()).toBeVisible();
  await gotoAuthenticatedPage(page, "/activity");
  await expect(
    page.getByText("Recent changes across all entities."),
  ).toBeVisible();
  await gotoAuthenticatedPage(page, "/settings?purchaseAgent=dispatch_failed");
  await expect(
    page.getByText(
      /The agent is authorized, but some work could not be dispatched/,
    ),
  ).toBeVisible();
  await expectViewportBounded(page);
});
