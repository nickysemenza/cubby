import { seedTaskPrerequisite } from "./e2e-fixtures";
import { expectViewportBounded, waitForAppHydration } from "./e2e-helpers";
import { expect, test } from "./e2e-test";

function sameTransformWithinTolerance(
  initial: string | null,
  current: string | null,
) {
  if (!initial || !current) return initial === current;
  const initialValues = initial.match(/-?[\d.]+/gu)?.map(Number);
  const currentValues = current.match(/-?[\d.]+/gu)?.map(Number);
  if (!initialValues || !currentValues) return false;
  return (
    initialValues.length === currentValues.length &&
    initialValues.every(
      (value, index) => Math.abs(value - (currentValues[index] ?? NaN)) < 0.001,
    )
  );
}

test("work graph renders through Viz, restores filters, and opens a graph node", async ({
  page,
}, testInfo) => {
  const name = `e2e graph task ${Date.now()}`;
  const task = await seedTaskPrerequisite(page, { name });

  await page.goto("/entities?tab=work");
  await waitForAppHydration(page);

  const graph = page.locator('svg[aria-label="Entity dependency graph"]');
  await expect(graph).toBeVisible({ timeout: 15_000 });
  await expect(graph.locator("a").filter({ hasText: name })).toBeVisible();
  const graphLink = graph.locator("a").filter({ hasText: name });
  await expect(graphLink).toHaveAttribute("xlink:href", `/tasks/${task.id}`);

  const viewport = graph.locator(".svg-pan-zoom_viewport");
  await expect(viewport).toBeVisible();
  const initialTransform = await viewport.getAttribute("transform");
  await page.getByRole("button", { name: "Zoom in" }).click();
  await expect
    .poll(() => viewport.getAttribute("transform"))
    .not.toBe(initialTransform);
  await page.getByRole("button", { name: "Reset view" }).click();
  await expect
    .poll(async () =>
      sameTransformWithinTolerance(
        initialTransform,
        await viewport.getAttribute("transform"),
      ),
    )
    .toBe(true);

  const types = page.getByRole("combobox", { name: "Record types" });
  await types.selectOption("project");
  await expect(graphLink).toHaveCount(0);
  await types.selectOption("task");
  await expect(graphLink).toBeVisible();

  const find = page.getByRole("textbox", { name: "Find graph record" });
  await find.fill(name);
  await expect(page).toHaveURL((url) => url.searchParams.get("q") === name);
  await page.reload();
  await waitForAppHydration(page);
  await expect(find).toHaveValue(name);
  await expect(types).toHaveValue("task");
  await expect(graph).toBeVisible({ timeout: 15_000 });

  await page.screenshot({
    path: testInfo.outputPath("entity-dependency-graph-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(graph).toBeVisible();
  await expectViewportBounded(page);
  await expect
    .poll(async () =>
      graph.evaluate((svg) => {
        const frame = svg.getBoundingClientRect();
        return Array.from(svg.querySelectorAll("a")).every((link) => {
          const bounds = link.getBoundingClientRect();
          return bounds.left >= frame.left && bounds.right <= frame.right;
        });
      }),
    )
    .toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("entity-dependency-graph-phone.png"),
    fullPage: true,
  });

  await graphLink.click();
  await expect(page).toHaveURL(new RegExp(`/tasks/${task.id}$`));
});

test("legacy recipe graph URL still opens its graph controls", async ({
  page,
}) => {
  await page.goto("/entities?tab=recipes&hide=false");
  await waitForAppHydration(page);

  await expect(page.getByRole("tab", { name: "Recipe graph" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByText(/Each arrow means “uses”/u)).toBeVisible();
  await expect(
    page.getByRole("checkbox", { name: "Hide unconnected recipes" }),
  ).not.toBeChecked();
  await expect(
    page.locator('svg[aria-label="Entity dependency graph"]'),
  ).toBeVisible({ timeout: 15_000 });
});
