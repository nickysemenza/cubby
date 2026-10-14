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
 * Every Runs cursor crosses its first page: the history list in both sort
 * scopes, then one job's attempts (`nextAttemptCursor`) and events. A
 * repeated first page, a page kept from the other scope, or a lost cursor
 * leaves the second-page rows unreachable.
 */
test("Runs pages history, attempts, and events past one cursor page", async ({
  page,
}) => {
  const name = uniqueName(test.info(), "Paged history");
  const sample = await seedPagedActivityHistory(name, 22);
  await page.setViewportSize({ width: 1440, height: 2400 });
  const table = page.getByRole("table", { name: "Image jobs" });
  // Keep all fixture rows inside the virtual window. The unfilled pane loads
  // page two automatically; asserting every row once verifies cursor order
  // without confusing an unmounted row with a missing result.
  const filenamePattern = new RegExp(`${name} (\\d{2})\\.png`, "g");
  const listedJobs = async () => {
    const text = (await table.textContent()) ?? "";
    return Array.from(text.matchAll(filenamePattern), (match) => match[1]);
  };
  const newestFirst = Array.from({ length: 22 }, (_, index) =>
    String(index + 1).padStart(2, "0"),
  );
  const history = `/runs?view=image-jobs&submissionId=${sample.submissionId}`;

  await gotoAuthenticatedPage(page, history);
  await expect.poll(listedJobs).toEqual(newestFirst);

  await gotoAuthenticatedPage(page, `${history}&order=oldest`);
  await expect.poll(listedJobs).toEqual([...newestFirst].reverse());

  await gotoAuthenticatedPage(page, `/runs/jobs/${sample.newestJobId}`);
  const attempt = (number: number) =>
    page.getByText(new RegExp(`^Attempt #${number} · Failed · `));
  await expect(attempt(22)).toBeVisible();
  await expect(attempt(1)).toHaveCount(0);
  await page.getByRole("button", { name: "Load more attempts" }).click();
  await expect(attempt(1)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Load more attempts" }),
  ).toHaveCount(0);

  const events = page.getByText(/synthetic\.step\.\d{2}/);
  await expect(events).toHaveCount(20);
  await page.getByRole("button", { name: "Load more events" }).click();
  await expect(events).toHaveCount(22);
  await expect(
    page.getByRole("button", { name: "Load more events" }),
  ).toHaveCount(0);
});

test("Image jobs browse with a responsive inspector, while Activity shows changes", async ({
  page,
}) => {
  const sample = await seedActivityHistory(
    page,
    `Synthetic history ${Date.now()}`,
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoAuthenticatedPage(
    page,
    `/runs?view=image-jobs&subjectId=${sample.imageId}`,
  );
  const table = page.getByRole("table", { name: "Image jobs" });
  await expect(table).toContainText(sample.filename);
  // The Work column names image jobs by their kind.
  await expect(table).toContainText("Subject lift");
  await expect(table).toContainText("Image description");
  await gotoAuthenticatedPage(
    page,
    `/runs?view=image-jobs&selected=${sample.jobId}`,
  );
  await expect(
    page.getByRole("button", { name: "Copy diagnostics", exact: true }).first(),
  ).toBeVisible();
  await page.getByText("Diagnostics and result", { exact: true }).click();
  await expect(page.getByText(/synthetic-vision/)).toBeVisible();
  await expect(
    page.getByRole("link", { name: `Parent ${sample.runId}` }),
  ).toBeVisible();

  await page.setViewportSize({ width: 900, height: 900 });
  await gotoAuthenticatedPage(
    page,
    `/runs?view=image-jobs&selected=${sample.jobId}`,
  );
  await expect(page.getByRole("dialog")).toContainText(sample.jobId);
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoAuthenticatedPage(
    page,
    `/runs?view=image-jobs&selected=${sample.jobId}`,
  );
  await expect(page).toHaveURL(new RegExp(`/runs/jobs/${sample.jobId}$`));
  await gotoAuthenticatedPage(page, `/runs/jobs/${sample.jobId}`);
  await expect(page.getByText(sample.jobId).first()).toBeVisible();
  await gotoAuthenticatedPage(page, `/runs/${sample.runId}`);
  await expect(
    page.getByText(sample.runId).filter({ visible: true }).first(),
  ).toBeVisible();
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
