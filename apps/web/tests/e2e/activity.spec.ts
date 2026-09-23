import { seedActivityHistory } from "./e2e-fixtures";
import { expectViewportBounded, gotoAuthenticatedPage } from "./e2e-helpers";
import { expect, test } from "./e2e-test";

test("Activity preserves audit links, authorization feedback, and recorded image diagnostics", async ({
  page,
}) => {
  const sample = await seedActivityHistory(`Activity sample ${Date.now()}`);
  await gotoAuthenticatedPage(
    page,
    `/activity?subjectId=${sample.imageId}&selectedRun=${sample.runId}`,
  );
  await expect(
    page.getByRole("tab", { name: "Runs", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("table", { name: "Activity runs" }),
  ).toContainText(sample.filename);
  await page.getByText("Diagnostics and result", { exact: true }).click();
  await expect(page.getByText(/synthetic-vision/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Copy diagnostics", exact: true }).first(),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Refresh runs", exact: true }),
  ).toBeVisible();
  await gotoAuthenticatedPage(page, "/activity?entityType=product&source=web");
  await expect(
    page.getByRole("tab", { name: "Changes", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await gotoAuthenticatedPage(
    page,
    "/activity?tab=connections&purchaseAgent=dispatch_failed",
  );
  await expect(
    page.getByText(
      /The agent is authorized, but some work could not be dispatched/,
    ),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Runs", exact: true }).click();
  await expect(
    page.getByRole("tab", { name: "Runs", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expectViewportBounded(page);
});
