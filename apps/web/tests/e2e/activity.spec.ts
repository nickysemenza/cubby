import { seedActivityHistory } from "./e2e-fixtures";
import { expectViewportBounded, gotoAuthenticatedPage } from "./e2e-helpers";
import { expect, test } from "./e2e-test";

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
