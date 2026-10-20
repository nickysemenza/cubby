import { createEntityFixture } from "./fixtures/core";
import { gotoAuthenticatedPage } from "./support/e2e-helpers";
import { expect, test } from "./support/e2e-test";

// Research uses the ordinary editor: later edits replace notes, with no citation currentness contract.
test("research notes remain readable and editable on the record", async ({
  page,
}) => {
  const product = await createEntityFixture(page, "product", {
    name: "Synthetic research tool",
    notes:
      "Original notes.\nResearch: maker lists model A12, blue variant. https://example.test/specification",
  });
  await gotoAuthenticatedPage(page, `/products/${product.id}`);
  const notes = page
    .locator('[data-ledger="facts"] .ledger-row')
    .filter({
      has: page.getByText("Notes", { exact: true }),
    })
    .first();
  await expect(notes).toContainText("Original notes.");
  await expect(notes).toContainText("maker lists model A12");
  await notes.getByRole("button", { name: "Edit value", exact: true }).click();
  const editor = page.locator('[data-slot="cell-editor-overlay"]');
  await editor
    .getByRole("textbox")
    .fill("Reviewed research: model B14. https://example.test/review");
  await editor.getByRole("button", { name: "Save value", exact: true }).click();
  await expect(notes).toContainText("Reviewed research: model B14.");
  await page.reload();
  await expect(notes).toContainText("Reviewed research: model B14.");
  await expect(page.locator("#sources")).toHaveCount(0);
});
