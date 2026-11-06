import { buildEntity } from "#web/tooling/factories/build.ts";
import { ingredientShortcode } from "@cubby/schemas/identifiers";
import { z } from "zod";

import { entityApi } from "./support/entity-api";
import { gotoAuthenticatedPage } from "./support/e2e-helpers";
import { expect, test } from "./support/e2e-test";

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
  await expect(page.getByTestId("work-health")).toContainText(/background/i);
  await expect(page.getByRole("tab")).toHaveCount(0);
  const more = page.getByRole("navigation", { name: "More work" });
  await expect(more.getByRole("link", { name: "Suggestions" })).toBeVisible();
  await expect(more.getByRole("link", { name: "Missing facts" })).toBeVisible();
  await expect(more.getByRole("link", { name: "All work" })).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("work-desktop.png"),
    fullPage: true,
  });

  // Automatic AI work has no Run to stop, so a member stops and resumes it here.
  await more.getByRole("button", { name: "Stop automatic AI work" }).click();
  const stopped = page.getByTestId("automatic-work-stopped");
  await expect(stopped).toContainText("wait until you resume");
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
    await expect(page.getByText("The Jobs page is gone.")).toBeVisible();
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
  await expect(page.getByTestId("work-health")).toContainText(/background/i);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("work-phone.png"),
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
