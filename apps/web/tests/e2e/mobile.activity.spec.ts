import { seedActivityHistory } from "./e2e-fixtures";
import { expectViewportBounded, gotoAuthenticatedPage } from "./e2e-helpers";
import { expect, test } from "./e2e-test";

test("Activity runs with recorded diagnostics stay within the phone viewport", async ({
  page,
}) => {
  const sample = await seedActivityHistory(`Activity phone ${Date.now()}`);
  await gotoAuthenticatedPage(
    page,
    `/activity?subjectId=${sample.imageId}&selectedRun=${sample.runId}`,
  );
  await expect(
    page.getByRole("tab", { name: "Runs", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await page.getByText("Diagnostics and result", { exact: true }).click();
  await expect(page.getByText(/synthetic-vision/)).toBeVisible();
  await expectViewportBounded(page);
});
