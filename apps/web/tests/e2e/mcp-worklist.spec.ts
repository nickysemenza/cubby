import { gotoAuthenticatedPage } from "./e2e-helpers";
import { expect, test } from "./e2e-test";

test("MCP worklist opens selected tool beside the table and in a narrower right sheet", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoAuthenticatedPage(page, "/mcp");
  const worklist = page.getByRole("table", {
    name: "MCP tool pruning worklist",
  });
  await expect(worklist).toBeVisible();
  await worklist.getByRole("row").nth(1).click();
  const inspector = page.getByRole("complementary", {
    name: "Selected tool detail",
  });
  await expect(inspector).toBeVisible();
  await expect(inspector.getByText("Input schema")).toBeVisible();
  const tableBox = await worklist.getByRole("row").nth(1).boundingBox();
  const inspectorBox = await inspector.boundingBox();
  expect(
    tableBox &&
      inspectorBox &&
      inspectorBox.x > tableBox.x + tableBox.width / 2,
  ).toBeTruthy();
  await page.setViewportSize({ width: 900, height: 900 });
  await expect(page.getByRole("dialog")).toContainText("Input schema");
});
