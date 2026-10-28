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
  await expect(
    page.getByRole("tab", { name: "Needs you", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("heading", { name: "Decisions", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Problems", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("tabpanel").locator('[aria-busy="true"]'),
  ).toHaveCount(0);
  for (const tab of await page.getByRole("tab").all())
    expect(
      await tab.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("activity-needs-you-desktop.png"),
    fullPage: true,
  });

  await page
    .getByRole("tab", { name: "Advanced maintenance", exact: true })
    .click();
  await expect(page).toHaveURL(/tab=maintenance/);
  await expect(
    page.getByRole("heading", { name: "Nightly maintenance", exact: true }),
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
    path: testInfo.outputPath("activity-maintenance-desktop.png"),
    fullPage: true,
  });

  // Moving between views must preserve an inspected preview and its action state.
  await page.getByRole("tab", { name: "Now", exact: true }).click();
  await expect(page).toHaveURL(/tab=now/);
  await page
    .getByRole("tab", { name: "Advanced maintenance", exact: true })
    .click();
  await expect(apply).toBeEnabled();
  await apply.click();
  await expect.poll(storedRecipe).toMatchObject({
    sections: [{ ingredients: [{ amounts: [{ value: 2, unit: "cup" }] }] }],
  });
  await expect(apply).toBeDisabled();

  await page
    .getByRole("link", { name: "What does each Run do?", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "What does each Run do?", exact: true }),
  ).toBeVisible();
  await page.goto("/runs/types#maintenance");
  await expect(
    page.getByRole("heading", { name: "Maintenance", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("run-types-desktop.png"),
    fullPage: false,
  });
  await page.goto("/runs/types#job-jobs.maintenance");
  await expect(
    page.getByRole("heading", { name: "Internal queue upkeep", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("This is separate from the nightly maintenance Run.", {
      exact: false,
    }),
  ).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await gotoAuthenticatedPage(page, "/activity?tab=maintenance");
  await expect(
    page.getByRole("heading", { name: "Nightly maintenance", exact: true }),
  ).toBeVisible();
  for (const tab of await page.getByRole("tab").all())
    expect(
      await tab.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await expect(
    page.getByRole("tab", { name: "History", exact: true }),
  ).toBeEnabled();
  await page.screenshot({
    path: testInfo.outputPath("activity-maintenance-phone.png"),
    fullPage: true,
  });
  await page.getByRole("tab", { name: "History", exact: true }).click();
  await expect(page).toHaveURL(/tab=history/);
  await expect(
    page.getByRole("heading", { name: "Run history", exact: true }),
  ).toBeVisible();
  await page.goBack();
  await expect(
    page.getByRole("tab", { name: "Advanced maintenance", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await page.goto("/runs/types#maintenance");
  await expect(
    page.getByRole("heading", { name: "Maintenance", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("run-types-phone.png"),
    fullPage: false,
  });
});
