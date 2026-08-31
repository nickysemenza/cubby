import { randomBytes } from "node:crypto";

import { Pool } from "pg";

import { gotoAuthenticatedPage, selectComboboxItem } from "./e2e-helpers";
import { expect, test } from "./e2e-test";

const SHORTCODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

function shortcode(prefix: "LPY" | "MEL" | "RCP") {
  const bytes = randomBytes(4);
  const suffix = [...bytes]
    .map((byte) => SHORTCODE_ALPHABET[byte % SHORTCODE_ALPHABET.length])
    .join("");
  return `${prefix}-${suffix}`;
}

test("plans, weighs, confirms, and serves a leftover recipe portion", async ({
  page,
}) => {
  const databaseUrl = process.env.E2E_DATABASE_URL;
  if (!databaseUrl) throw new Error("E2E database was unavailable");

  const stamp = Date.now();
  const recipeName = `E2E grain bowl ${stamp}`;
  const sourceName = `E2E cook night ${stamp}`;
  const leftoverName = `E2E leftovers ${stamp}`;
  const eaterName = `E2E member ${stamp}`;
  const recipeCode = shortcode("RCP");
  const sourceCode = shortcode("MEL");
  const leftoverCode = shortcode("MEL");
  const eaterCode = shortcode("LPY");

  const pool = new Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const recipe = await client.query<{ id: string }>(
      `INSERT INTO "Recipe"
        ("shortcode", "name", "yield", "totals", "totalsComputedAt")
       VALUES ($1, $2, $3::jsonb, $4::jsonb, NOW())
       RETURNING "id"`,
      [
        recipeCode,
        recipeName,
        JSON.stringify({ value: 500, unit: "g" }),
        JSON.stringify({
          costTotal: 0,
          caloriesTotal: 1000,
          ingredientCount: 1,
          costCovered: 1,
          caloriesCovered: 1,
        }),
      ],
    );
    const source = await client.query<{ id: string }>(
      `INSERT INTO "Meal" ("shortcode", "date", "name", "mealKind")
       VALUES ($1, '2026-10-01', $2, 'cooked')
       RETURNING "id"`,
      [sourceCode, sourceName],
    );
    await client.query(
      `INSERT INTO "Meal" ("shortcode", "date", "name", "mealKind")
       VALUES ($1, '2026-10-02', $2, 'leftovers')`,
      [leftoverCode, leftoverName],
    );
    await client.query(
      `INSERT INTO "LedgerParty" ("shortcode", "name", "kind")
       VALUES ($1, $2, 'member')`,
      [eaterCode, eaterName],
    );
    await client.query(
      `INSERT INTO "MealRecipe" ("mealId", "recipeId", "scale")
       VALUES ($1, $2, 1)`,
      [source.rows[0]?.id, recipe.rows[0]?.id],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }

  await gotoAuthenticatedPage(
    page,
    `/meals/${sourceCode}`,
    page.getByRole("heading", { level: 1, name: sourceName }),
  );
  await page.getByRole("button", { name: "Portions" }).click();
  let sheet = page.getByRole("dialog", {
    name: `Portions · ${recipeName}`,
  });
  await expect(sheet).toBeVisible();
  await sheet.getByLabel("Expected (g)").fill("600");
  await sheet.getByLabel("Made (g)").fill("500");
  await selectComboboxItem(
    page,
    sheet.getByRole("combobox", { name: "Eater" }),
    eaterName,
  );
  await sheet.getByLabel("Grams").fill("200");
  await sheet.getByRole("checkbox", { name: "Confirmed eaten" }).check();
  await sheet.getByRole("button", { name: "Save portions" }).click();

  await expect(page.getByText("Consumed calories")).toBeVisible();
  await expect(page.getByText("200 g", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Confirmed", { exact: true }).last(),
  ).toBeVisible();

  await page.getByRole("button", { name: "Portions" }).click();
  sheet = page.getByRole("dialog", { name: `Portions · ${recipeName}` });
  await sheet.getByRole("button", { name: "Add person" }).click();
  const secondMealPicker = page
    .locator('input[role="combobox"][aria-label="Meal"]')
    .nth(1);
  await selectComboboxItem(page, secondMealPicker, leftoverName);
  await sheet.getByLabel("Grams").nth(1).fill("150");
  await sheet.getByRole("button", { name: "Save portions" }).click();

  await gotoAuthenticatedPage(
    page,
    `/meals/${leftoverCode}`,
    page.getByRole("heading", { level: 1, name: leftoverName }),
  );
  await expect(page.getByText(recipeName, { exact: true })).toBeVisible();
  await expect(page.getByText("150 g", { exact: true })).toBeVisible();
  await expect(page.getByText("Planned", { exact: true })).toBeVisible();
});
