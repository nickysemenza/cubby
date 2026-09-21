import { seedToolFlowPrerequisite } from "./e2e-fixtures";
import { expectViewportBounded, gotoAuthenticatedPage } from "./e2e-helpers";
import { expect, test } from "./e2e-test";

test("tool Flow keeps group order across pagination, jumps to unloaded groups, and reflows around inspection", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  page.setDefaultTimeout(15_000);
  // Keep the first page below the 500px prefetch margin until a section jump.
  await page.setViewportSize({ width: 1600, height: 500 });
  const prefix = `Tool flow ${Date.now()}`;
  const seededGroups = await seedToolFlowPrerequisite(page, [
    {
      locationName: `${prefix} A workshop`,
      productNames: Array.from(
        { length: 56 },
        (_, index) => `${prefix} alpha ${String(index).padStart(2, "0")}`,
      ),
    },
    {
      locationName: `${prefix} B unusually long precision-tool storage heading that must wrap cleanly`,
      productNames: Array.from(
        { length: 6 },
        (_, index) => `${prefix} beta ${String(index).padStart(2, "0")}`,
      ),
    },
    {
      locationName: `${prefix} C late shed`,
      productNames: Array.from(
        { length: 3 },
        (_, index) => `${prefix} gamma ${String(index).padStart(2, "0")}`,
      ),
    },
  ]);
  const firstGroup = seededGroups[0];
  const splitGroup = seededGroups[1];
  const lateGroup = seededGroups[2];
  if (!firstGroup || !splitGroup || !lateGroup) {
    throw new Error("Tool Flow fixture did not create its three groups");
  }

  await gotoAuthenticatedPage(page, `/tools?q=${encodeURIComponent(prefix)}`);
  await page.getByRole("button", { name: "Flow view", exact: true }).click();

  const flow = page.getByTestId("grouped-flow");
  const firstMarker = flow.locator(
    `[data-grouped-flow-group="${firstGroup.location.id}"]`,
  );
  const splitMarker = flow.locator(
    `[data-grouped-flow-group="${splitGroup.location.id}"]`,
  );
  await expect(firstMarker).toContainText(firstGroup.locationName);
  await expect(firstMarker).toContainText("56");
  await expect(splitMarker).toContainText("6");
  await expect(
    flow.locator(
      `[aria-describedby="grouped-flow-group-${splitGroup.location.id}-heading"]`,
    ),
  ).toHaveCount(4);

  const packing = await flow.evaluate(
    (node, ids) => {
      const marker = node.querySelector<HTMLElement>(
        `[data-grouped-flow-group="${ids.split}"]`,
      );
      const firstItem = node.querySelector<HTMLElement>(
        `[aria-describedby="grouped-flow-group-${ids.split}-heading"]`,
      );
      const firstGroupLastItem = Array.from(
        node.querySelectorAll<HTMLElement>(
          `[aria-describedby="grouped-flow-group-${ids.first}-heading"]`,
        ),
      ).find((button) => button.textContent?.includes(ids.lastName));
      if (!marker || !firstItem || !firstGroupLastItem) return null;
      const markerRect = marker.getBoundingClientRect();
      const itemRect = firstItem.getBoundingClientRect();
      const previousRect = firstGroupLastItem.getBoundingClientRect();
      return {
        dividerSpansTwoCards: markerRect.width > itemRect.width * 1.8,
        nextGroupStartsAfterItsDivider: itemRect.top >= markerRect.top,
        dividerSharesThePreviousPackedRow:
          Math.abs(markerRect.top - previousRect.top) < 2,
      };
    },
    {
      first: firstGroup.location.id,
      split: splitGroup.location.id,
      lastName: `${prefix} alpha 55`,
    },
  );
  expect(packing).toEqual({
    dividerSpansTwoCards: true,
    nextGroupStartsAfterItsDivider: true,
    dividerSharesThePreviousPackedRow: true,
  });
  await expectViewportBounded(page);
  const lateMarker = flow.locator(
    `[data-grouped-flow-group="${lateGroup.location.id}"]`,
  );
  // Jump before scrolling near the sentinel: otherwise automatic pagination
  // would load this group and hide a regression in the jump's page fetching.
  await expect(lateMarker).toHaveCount(0);
  await page
    .getByRole("button")
    .filter({ hasText: lateGroup.locationName })
    .click();
  await expect(lateMarker).toBeInViewport();
  await expect(
    flow.locator(`[data-grouped-flow-group="${splitGroup.location.id}"]`),
  ).toHaveCount(1);
  await expect(
    flow.locator(
      `[aria-describedby="grouped-flow-group-${splitGroup.location.id}-heading"]`,
    ),
  ).toHaveCount(6);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await splitMarker.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: testInfo.outputPath("desktop-flow.png"),
    animations: "disabled",
  });

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
  await page.screenshot({
    path: testInfo.outputPath("desktop-flow-inspector.png"),
    animations: "disabled",
  });

  await page
    .getByRole("button", { name: "Close inspector", exact: true })
    .first()
    .click();
  await page
    .getByRole("textbox", { name: "Search inventoried tools", exact: true })
    .fill(`${prefix} gamma 00`);
  await expect(flow.getByRole("button")).toHaveCount(1);
  await page
    .getByRole("combobox", { name: "Group by", exact: true })
    .selectOption("manufacturer");
  await expect(
    flow.getByRole("heading", { name: "Flow fixture maker", exact: true }),
  ).toBeVisible();
  await expect(flow.getByRole("button")).toHaveCount(1);

  await page.reload();
  await expect(page.getByTestId("grouped-flow")).toHaveCount(0);
  await expect(page.locator("[data-tool-gallery-group]").first()).toBeVisible();
});
