import { expect, test } from "./e2e-test";

// The showcase renders the real components over synthetic fixtures. Failure
// modes: a fixture evaluated at module scope (randomness, WASM) crashes SSR, a
// demo throws and takes the page down, or the picker and table stop driving
// their local state.
test("design showcase renders every section and its live demos", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  const response = await page.goto("/design");
  expect(response?.status()).toBe(200);

  for (const title of [
    "Foundations",
    "Picker",
    "Records: ledger and timeline",
    "RTable",
    "LocationTree",
    "Dates, pills and filters",
    "Recipe text and unit conversion",
    "Controls",
    "Feedback, dialogs and tabs",
  ]) {
    await expect(
      page.getByRole("heading", { name: title, exact: true }),
    ).toBeVisible();
  }

  const picker = page.locator("#picker");
  await picker.getByRole("combobox", { name: "Product" }).first().click();
  await expect(
    page.getByRole("option", { name: /Basmati rice/ }),
  ).toBeVisible();
  await page.keyboard.press("Escape");

  const records = page.locator("#records");
  await expect(
    records.getByRole("region", { name: "Import pipeline" }),
  ).toContainText("Not reached");
  // Captures carry no `key`; choosing one must still select it.
  await records.getByRole("button", { name: "View Nutrition" }).click();
  await expect(
    records.getByRole("region", { name: "Selected record" }),
  ).toContainText("Nutrition");

  // Oat milk starts with 2 on hand; the bulk action writes page state only.
  const table = page.locator("#rtable");
  const oatMilk = table.getByRole("row", { name: /Oat milk/ });
  await oatMilk.getByRole("checkbox").check();
  await table.getByRole("button", { name: "Mark restocked" }).click();
  await expect(
    oatMilk.getByRole("cell", { name: "3", exact: true }),
  ).toBeVisible();

  expect(pageErrors).toEqual([]);
});
