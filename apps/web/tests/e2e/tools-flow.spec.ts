import { seedToolFlowPrerequisite } from "./fixtures/catalog";
import {
  chooseOption,
  expectViewportBounded,
  gotoAuthenticatedPage,
} from "./support/e2e-helpers";
import { expect, test } from "./support/e2e-test";

test("tool Flow searches, groups, and opens a real record in inspection", async ({
  page,
}) => {
  page.setDefaultTimeout(15_000);
  // Page splitting and unloaded-group jumps belong to tool-gallery-page tests;
  // this journey owns real records, keyboard inspection, search and grouping.
  await page.setViewportSize({ width: 1600, height: 1000 });
  const prefix = `Tool flow ${Date.now()}`;
  const seededGroups = await seedToolFlowPrerequisite(page, [
    {
      locationName: `${prefix} A workshop`,
      productNames: Array.from(
        { length: 2 },
        (_, index) => `${prefix} alpha ${String(index).padStart(2, "0")}`,
      ),
    },
    {
      locationName: `${prefix} B unusually long precision-tool storage heading that must wrap cleanly`,
      productNames: Array.from(
        { length: 2 },
        (_, index) => `${prefix} beta ${String(index).padStart(2, "0")}`,
      ),
    },
    {
      locationName: `${prefix} C late shed`,
      productNames: Array.from(
        { length: 1 },
        (_, index) => `${prefix} gamma ${String(index).padStart(2, "0")}`,
      ),
    },
  ]);
  await gotoAuthenticatedPage(page, `/tools?q=${encodeURIComponent(prefix)}`);
  await page
    .getByRole("group", { name: "Tools view" })
    .getByRole("button", { name: "Flow", exact: true })
    .click();

  const flow = page.getByTestId("grouped-flow");
  for (const group of seededGroups) {
    await expect(
      flow.getByRole("heading", { name: group.locationName, exact: true }),
    ).toBeVisible();
  }
  await expectViewportBounded(page);

  const flowBeforeInspection = await flow.boundingBox();
  if (!flowBeforeInspection)
    throw new Error("Tool Flow grid is not measurable");
  const inspectedCard = flow.getByRole("button", {
    name: new RegExp(`${prefix} gamma 00`),
  });
  await inspectedCard.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("complementary", { name: "Product inspector" }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("complementary", { name: "Product inspector" })
      .getByRole("heading", { name: `${prefix} gamma 00`, exact: true }),
  ).toBeVisible();
  await expect
    .poll(async () => (await flow.boundingBox())?.width ?? 0)
    .toBeLessThan(flowBeforeInspection.width - 300);
  await expectViewportBounded(page);

  await page
    .getByRole("button", { name: "Close inspector", exact: true })
    .first()
    .click();
  await page
    .getByRole("textbox", { name: "Search inventoried tools", exact: true })
    .fill(`${prefix} gamma 00`);
  await expect(flow.getByRole("button")).toHaveCount(1);
  await chooseOption(
    page,
    page.getByRole("combobox", { name: "Group by", exact: true }),
    "Manufacturer",
  );
  await expect(
    flow.getByRole("heading", { name: "Flow fixture maker", exact: true }),
  ).toBeVisible();
  await expect(flow.getByRole("button")).toHaveCount(1);

  await page.reload();
  await expect(page.getByTestId("grouped-flow")).toHaveCount(0);
  await expect(page.locator("[data-tool-gallery-group]").first()).toBeVisible();
});
