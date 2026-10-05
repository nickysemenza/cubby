import {
  seedActivityHistory,
  seedPagedActivityHistory,
} from "./fixtures-photos";
import {
  expectViewportBounded,
  gotoAuthenticatedPage,
  uniqueName,
} from "./e2e-helpers";
import { expect, test } from "./e2e-test";

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
  await page.setViewportSize({ width: 1440, height: 900 });
  const table = page.getByRole("table", { name: "Runs and image jobs" });
  // The list loads its next page on its own whenever the first 20 rows do not
  // fill the viewport, so whether page two is present yet is a race; assert
  // only the settled listing. All 22 jobs, each exactly once and in the
  // scope's order, can only come from following the cursor without skipping
  // or repeating a row.
  const filenamePattern = new RegExp(`${name} (\\d{2})\\.png`, "g");
  const listedJobs = async () => {
    await table.hover();
    await page.mouse.wheel(0, 4000);
    const text = (await table.textContent()) ?? "";
    return Array.from(text.matchAll(filenamePattern), (match) => match[1]);
  };
  const newestFirst = Array.from({ length: 22 }, (_, index) =>
    String(index + 1).padStart(2, "0"),
  );
  const history = `/runs?submissionId=${sample.submissionId}`;

  await gotoAuthenticatedPage(page, history);
  await expect.poll(listedJobs).toEqual(newestFirst);

  await gotoAuthenticatedPage(page, `${history}&sort=oldest`);
  await expect.poll(listedJobs).toEqual([...newestFirst].reverse());

  await gotoAuthenticatedPage(page, `/runs/jobs/${sample.newestJobId}`);
  const attempt = (number: number) =>
    page.getByText(new RegExp(`^#${number} · failed · `));
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

test("Runs browse flat and grouped work with a responsive inspector, while Activity shows changes", async ({
  page,
}) => {
  const sample = await seedActivityHistory(
    page,
    `Synthetic history ${Date.now()}`,
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoAuthenticatedPage(page, `/runs?subjectId=${sample.imageId}`);
  const table = page.getByRole("table", { name: "Runs and image jobs" });
  await expect(table).toContainText(sample.filename);
  await expect(table).toContainText("Image job");
  await page.getByRole("button", { name: "Group by run" }).click();
  await expect(
    page.getByRole("button", { name: `Expand jobs for ${sample.runId}` }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: `Expand jobs for ${sample.runId}` })
    .click();
  await expect(table).toContainText("describe image");
  await expect(table).toContainText("subject lift");
  await gotoAuthenticatedPage(page, `/runs?selected=${sample.jobId}`);
  await expect(
    page.getByRole("button", { name: "Copy diagnostics", exact: true }).first(),
  ).toBeVisible();
  await page.getByText("Diagnostics and result", { exact: true }).click();
  await expect(page.getByText(/synthetic-vision/)).toBeVisible();
  await expect(
    page.getByRole("link", { name: `Parent ${sample.runId}` }),
  ).toBeVisible();

  await page.setViewportSize({ width: 900, height: 900 });
  await gotoAuthenticatedPage(page, `/runs?selected=${sample.jobId}`);
  await expect(page.getByRole("dialog")).toContainText(sample.jobId);
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoAuthenticatedPage(page, `/runs?selected=${sample.jobId}`);
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
