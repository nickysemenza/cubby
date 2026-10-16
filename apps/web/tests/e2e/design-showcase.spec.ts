import { expect, test } from "./support/e2e-test";

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
    "Action search and workflows",
    "Suggestion review",
    "Sections, dashboard and forms",
    "Record quality and charts",
    "Controls",
    "Feedback, dialogs and tabs",
  ]) {
    await expect(
      page.getByRole("heading", { name: title, exact: true }),
    ).toBeVisible();
  }

  // The record-detail contents index, shared through IndexedSections.
  await page
    .getByRole("navigation", { name: "Section index" })
    .getByRole("link", { name: "RTable" })
    .click();
  await expect(page).toHaveURL(/#rtable$/);

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

  await page
    .getByRole("button", { name: "Search demo actions", exact: true })
    .click();
  const command = page.getByRole("dialog", { name: "Demo actions" });
  await command.getByRole("combobox").fill("Review supplies");
  await command.getByRole("combobox").press("Enter");
  await expect(
    page.getByRole("status").filter({ hasText: "Review supplies selected" }),
  ).toBeVisible();

  const review = page
    .locator("figure")
    .filter({
      has: page.getByText("SuggestionReview · inline", { exact: true }),
    });
  await review.getByRole("button", { name: "Accept", exact: true }).click();
  await expect(review.getByRole("status")).toHaveText("Accepted locally");

  const sections = page.locator("#section-compositions");
  await sections.getByRole("button", { name: "Notes", exact: true }).click();
  await sections
    .getByRole("textbox", { name: "Task note" })
    .fill("Check spare parts");
  await sections.getByRole("button", { name: "Notes", exact: true }).click();
  await sections.getByRole("button", { name: "Notes", exact: true }).click();
  await expect(
    sections.getByRole("textbox", { name: "Task note" }),
  ).toHaveValue("Check spare parts");
  await expect(page.getByRole("button", { name: "Edit JSON" })).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});

// The workflow shares one shell on both viewports. A trigger must open the
// sheet as well as the desktop dialog; promoted actions must not hide errors.
for (const width of [1440, 402]) {
  test(`design workflow preserves pending and retry at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/design");
    await page
      .getByRole("button", { name: "Open demo workflow", exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "Review supplies for the workshop maintenance project",
    });
    await expect(
      dialog
        .getByText("A synthetic workflow; no record is written.", {
          exact: true,
        })
        .filter({ visible: true }),
    ).toBeVisible();
    if (width === 402) {
      const cancel = await dialog
        .getByRole("button", { name: "Cancel", exact: true })
        .boundingBox();
      const save = await dialog
        .getByRole("button", { name: "Save preview", exact: true })
        .boundingBox();
      const title = await dialog
        .getByRole("heading", {
          name: "Review supplies for the workshop maintenance project",
        })
        .boundingBox();
      expect(cancel).not.toBeNull();
      expect(save).not.toBeNull();
      expect(title).not.toBeNull();
      expect(cancel!.height).toBeGreaterThanOrEqual(44);
      expect(save!.height).toBeGreaterThanOrEqual(44);
      expect(cancel!.x + cancel!.width).toBeLessThanOrEqual(title!.x);
      expect(title!.x + title!.width).toBeLessThanOrEqual(save!.x);
      expect(save!.x + save!.width).toBeLessThanOrEqual(width);
    }
    await dialog
      .getByRole("textbox", { name: "Category name" })
      .fill("Synthetic tool supplies");
    await dialog
      .getByRole("button", { name: "Save preview", exact: true })
      .click();
    await expect(
      dialog.getByRole("button", { name: "Saving preview…", exact: true }),
    ).toBeDisabled();
    await expect(
      dialog.getByRole("button", { name: "Cancel", exact: true }),
    ).toBeDisabled();
    await expect(dialog.getByRole("alert")).toContainText("SQLSTATE 23514");
    await expect(dialog.getByText("1 category", { exact: true })).toBeVisible();
    await expect(
      dialog.getByRole("textbox", { name: "Category name" }),
    ).toHaveValue("Synthetic tool supplies");
    await dialog
      .getByRole("button", { name: "Retry preview", exact: true })
      .click();
    await expect(dialog).not.toBeVisible();
    await expect(
      page.getByRole("button", { name: "Open demo workflow", exact: true }),
    ).toBeFocused();
    await expect(
      page
        .getByRole("status")
        .filter({ hasText: "Preview saved: Synthetic tool supplies" }),
    ).toBeVisible();
  });
}
