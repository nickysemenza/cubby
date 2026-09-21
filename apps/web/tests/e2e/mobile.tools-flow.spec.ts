import { seedToolFlowPrerequisite } from "./e2e-fixtures";
import { expectViewportBounded, gotoAuthenticatedPage } from "./e2e-helpers";
import { expect, test } from "./e2e-test";

test("tool Flow keeps full-width group markers and usable cards at phone widths", async ({
  page,
}, testInfo) => {
  const prefix = `Phone tool flow ${Date.now()}`;
  const groups = await seedToolFlowPrerequisite(page, [
    {
      locationName: `${prefix} long utility closet heading that wraps`,
      productNames: [`${prefix} driver`, `${prefix} saw`],
    },
    {
      locationName: `${prefix} shed`,
      productNames: [`${prefix} level`, `${prefix} square`],
    },
  ]);
  const firstGroup = groups[0];
  if (!firstGroup)
    throw new Error("Phone Tool Flow fixture has no first group");

  await gotoAuthenticatedPage(page, `/tools?q=${encodeURIComponent(prefix)}`);
  await page.getByRole("button", { name: "Flow view", exact: true }).click();
  const flow = page.getByTestId("grouped-flow");
  await expect(flow.locator(":scope > [data-grouped-flow-group]")).toHaveCount(
    2,
  );

  for (const width of [320, 402]) {
    await page.setViewportSize({ width, height: 874 });
    await expectViewportBounded(page);
    const sizes = await flow.evaluate((node) => {
      const marker = node.querySelector<HTMLElement>(
        ":scope > [data-grouped-flow-group]",
      );
      return {
        flow: node.getBoundingClientRect().width,
        marker: marker?.getBoundingClientRect().width ?? 0,
      };
    });
    expect(sizes.marker).toBeGreaterThanOrEqual(sizes.flow - 1);
  }

  const firstCard = flow.getByRole("button", {
    name: new RegExp(`${prefix} driver`),
  });
  await expect(firstCard).toHaveAttribute(
    "aria-describedby",
    `grouped-flow-group-${firstGroup.location.id}-heading`,
  );
  await page.screenshot({
    path: testInfo.outputPath("phone-flow.png"),
    fullPage: true,
    animations: "disabled",
  });
  await firstCard.click();
  await expect(page).toHaveURL(/\/products\/PRD-/);
  await expect(
    page.getByRole("heading", { name: `${prefix} driver`, exact: true }),
  ).toBeVisible();
});
