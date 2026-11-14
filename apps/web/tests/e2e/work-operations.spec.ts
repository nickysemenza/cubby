import { buildEntity } from "#web/tooling/factories/build.ts";
import { ingredientShortcode } from "@cubby/schemas/identifiers";
import { workQueueOutSchema } from "@cubby/schemas/work-queue";
import { z } from "zod";

import { entityApi } from "./support/entity-api";
import { gotoAuthenticatedPage } from "./support/e2e-helpers";
import { expect, test } from "./support/e2e-test";
import { dispatchesOperation, operationResult } from "./support/dispatch-wire";

const createdIdentity = z.object({ item: z.object({ id: z.string() }) });

test("understand maintenance, preview a manual recipe repair, and verify its stored outcome", async ({
  page,
}, testInfo) => {
  const api = entityApi(page.request);
  const suffix = Date.now();
  const name = `Synthetic repair flour ${suffix}`;
  const ingredient = await api.create(
    "ingredient",
    buildEntity("ingredient", { name }),
  );
  expect(ingredient.status(), await ingredient.text()).toBe(200);
  const ingredientId = ingredientShortcode.parse(
    createdIdentity.parse(ingredient.parsedBody).item.id,
  );
  const recipe = await api.create(
    "recipe",
    buildEntity("recipe", {
      name: `Synthetic repair tart ${suffix}`,
      sections: [
        {
          name: "Crust",
          ingredients: [
            {
              type: "ingredient",
              ingredientId,
              recipeId: null,
              amounts: [{ value: 999, unit: "g" }],
              rawLine: `2 cups ${name}`,
            },
          ],
          instructions: [{ instruction: "Mix." }],
        },
      ],
    }),
  );
  expect(recipe.status(), await recipe.text()).toBe(200);
  const recipeId = createdIdentity.parse(recipe.parsedBody).item.id;
  const storedRecipe = async () =>
    (await api.get("recipe", recipeId)).parsedBody;

  await page.setViewportSize({ width: 1440, height: 1100 });
  await gotoAuthenticatedPage(page, "/activity");
  await expect(
    page.getByRole("heading", { name: "Needs you", exact: false }),
  ).toBeVisible();
  await expect(page.getByTestId("work-health")).toContainText(
    /stuck|Catching up/i,
  );
  await expect(page.getByRole("tab")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Queue and evaluations" }),
  ).toBeVisible();
  const more = page.getByRole("navigation", { name: "More work" });
  await expect(more.getByRole("link", { name: "Suggestions" })).toBeVisible();
  await expect(more.getByRole("link", { name: "Missing facts" })).toBeVisible();
  await expect(more.getByRole("link", { name: "All work" })).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("work-desktop.png"),
    fullPage: true,
  });

  // Overview counts open the same full population in Records, then the
  // shared pivot narrows it by Type without dropping the Reason predicate.
  await more.getByRole("link", { name: "All work", exact: true }).click();
  const summary = page.getByRole("table", { name: "Work items by reason" });
  await expect(summary).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("work-summary.png"),
    fullPage: true,
  });
  const count = summary.getByRole("button").first();
  const expectedCount = Number((await count.innerText()).replaceAll(",", ""));
  const drilled = page.waitForResponse((response) =>
    dispatchesOperation(
      response.request(),
      "workQueue.queue",
      ({ input }) =>
        z.object({ pageSize: z.number() }).parse(input).pageSize > 0,
    ),
  );
  await count.click();
  expect(
    (
      await operationResult(
        await drilled,
        "workQueue.queue",
        workQueueOutSchema,
      )
    ).meta.totalCount,
  ).toBe(expectedCount);
  await expect(page).toHaveURL(/layout=table/);
  const reason = new URL(page.url()).searchParams.get("reason");
  expect(reason).toBeTruthy();
  await page.getByRole("button", { name: "Summary", exact: true }).click();
  await expect(summary).toBeVisible();
  await page.getByRole("button", { name: "Pivot", exact: true }).click();
  const cell = page
    .locator("[data-pivot-cell]:not([aria-disabled=true])")
    .first();
  await expect(cell).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("work-pivot.png"),
    fullPage: true,
  });
  await cell.focus();
  await page.keyboard.press("ArrowRight");
  await cell.focus();
  const expectedCellCount = Number(
    (await cell.innerText()).replaceAll(",", ""),
  );
  const pivotDrilled = page.waitForResponse((response) =>
    dispatchesOperation(
      response.request(),
      "workQueue.queue",
      ({ input }) =>
        z.object({ pageSize: z.number() }).parse(input).pageSize > 0,
    ),
  );
  await cell.click();
  expect(
    (
      await operationResult(
        await pivotDrilled,
        "workQueue.queue",
        workQueueOutSchema,
      )
    ).meta.totalCount,
  ).toBe(expectedCellCount);
  await expect(page).toHaveURL(/layout=table/);
  expect(new URL(page.url()).searchParams.get("reason")).toBe(reason);
  expect(new URL(page.url()).searchParams.get("entity")).toBeTruthy();
  await page.reload();
  await expect(
    page
      .getByRole("group", { name: "Work queue layout" })
      .getByRole("button", { name: "Records", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await gotoAuthenticatedPage(page, "/activity");

  // Automatic AI work has no Run to stop, so a member stops and resumes it here.
  await more.getByRole("button", { name: "Stop automatic AI work" }).click();
  const stopped = page.getByTestId("automatic-work-stopped");
  await expect(stopped).toContainText("waits until you resume");
  await page.screenshot({
    path: testInfo.outputPath("work-automatic-stopped.png"),
    fullPage: true,
  });
  await page.reload();
  await expect(stopped).toBeVisible();
  await stopped.getByRole("button", { name: "Resume" }).click();
  await expect(stopped).toBeHidden();
  await expect(
    more.getByRole("button", { name: "Stop automatic AI work" }),
  ).toBeVisible();

  // Links into the retired views still land on their new owners.
  await page.goto("/activity?tab=history");
  await expect(page).toHaveURL(/\/history/);
  await expect(
    page.getByRole("heading", { name: "Run history", exact: true }),
  ).toBeVisible();
  await page.goto("/activity?tab=now");
  await expect(page.getByTestId("work-health")).toBeVisible();
  // So do links to the retired Jobs pages and codes.
  for (const retired of ["/jobs", "/jobs/JOB-SYNTH12345", "/JOB-SYNTH12345"]) {
    await page.goto(retired);
    await expect(page).toHaveURL(/\/activity\?from=jobs/);
    await expect(
      page.getByText(
        "Open a record's machinery to inspect its scopes, Asks and Passes.",
      ),
    ).toBeVisible();
  }
  await page.goto("/activity?tab=maintenance");
  await expect(page).toHaveURL(/\/settings#maintenance/);

  await expect(
    page.getByRole("heading", { name: "Daily maintenance", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "The maintenance pass, step by step" })
    .click();
  await expect(
    page.getByText("Email original disposal", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Image work admission", { exact: true }),
  ).toBeVisible();
  const apply = page.getByRole("button", { name: "Apply reparse repair" });
  await expect(apply).toBeDisabled();
  const reparse = page.getByRole("group", {
    name: "Re-parse lines",
    exact: true,
  });
  await reparse.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(apply).toBeEnabled();
  await expect(
    page.getByRole("table").filter({
      has: page.getByRole("columnheader", { name: "Proposed", exact: true }),
    }),
  ).toContainText("999 g");
  await expect.poll(storedRecipe).toMatchObject({
    sections: [{ ingredients: [{ amounts: [{ value: 999, unit: "g" }] }] }],
  });
  await page.screenshot({
    path: testInfo.outputPath("settings-maintenance-desktop.png"),
    fullPage: true,
  });

  await apply.click();
  await expect.poll(storedRecipe).toMatchObject({
    sections: [{ ingredients: [{ amounts: [{ value: 2, unit: "cup" }] }] }],
  });
  await expect(apply).toBeDisabled();

  await page.setViewportSize({ width: 390, height: 844 });
  await gotoAuthenticatedPage(page, "/activity");
  await expect(page.getByTestId("work-health")).toContainText(
    /stuck|Catching up/i,
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("work-phone.png"),
    fullPage: true,
  });
  await gotoAuthenticatedPage(page, "/work-queue?layout=pivot");
  await expect(page.locator("[data-pivot-cell]").first()).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("work-pivot-phone.png"),
    fullPage: true,
  });
  await gotoAuthenticatedPage(page, "/settings#maintenance");
  await expect(
    page.getByRole("heading", { name: "Daily maintenance", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await gotoAuthenticatedPage(page, "/history");
  await expect(
    page.getByRole("heading", { name: "Run history", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
