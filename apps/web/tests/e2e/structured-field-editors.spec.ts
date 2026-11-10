import { and, asc, eq } from "drizzle-orm";
import { entityExternalId } from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/db/helpers";
import { gotoAuthenticatedPage } from "./support/e2e-helpers";
import { expect, test } from "./support/e2e-test";
import { createEntityFixture, getFixtureDb } from "./fixtures/core";

// The generic structured-value editor crosses the generated schema, the form, and the server's
// own validation: each flow below fails if any of the three drifts.
test("Product identifier edits preserve additions and apply explicit identity actions", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 390, height: 844 });
  const source = `editor-${Date.now()}`;
  const product = await createEntityFixture(page, "product", {
    name: "Synthetic identifier editor sample",
    externalIds: [
      { source, kind: "catalog_number", externalId: "A", isPrimary: true },
    ],
  });
  const stored = () =>
    getDb(getFixtureDb())
      .select({
        code: entityExternalId.externalId,
        primary: entityExternalId.isPrimary,
      })
      .from(entityExternalId)
      .where(
        and(eq(entityExternalId.source, source), notDeleted(entityExternalId)),
      )
      .orderBy(asc(entityExternalId.externalId));
  await gotoAuthenticatedPage(page, `/products/${product.id}`);
  const edit = page.getByRole("button", { name: "Edit Product", exact: true });
  const dialog = page.getByRole("dialog", { name: "Edit Product" });
  const identifiers = dialog.getByRole("group", {
    name: "External IDs",
    exact: true,
  });
  const save = async () => {
    await dialog.getByRole("button", { name: "Save changes" }).click();
    await expect(dialog).toBeHidden();
  };

  await edit.click();
  await expect(dialog).toBeVisible();
  expect(pageErrors).toEqual([]);
  await dialog
    .getByRole("button", { name: "Add identifier", exact: true })
    .click();
  await dialog
    .getByRole("textbox", { name: "Source", exact: true })
    .fill(source);
  await identifiers
    .getByRole("combobox", { name: "Kind", exact: true })
    .click();
  await page
    .getByRole("option", { name: "Catalog number", exact: true })
    .click();
  // One-character catalog codes keep this editor journey independent of AI hints.
  await dialog
    .getByRole("textbox", { name: "External id", exact: true })
    .fill("B");
  // One draft can add a secondary, select it as primary and replace the saved
  // identifier. SQL owns the intermediate add-preserves-primary state.
  await dialog
    .getByRole("button", { name: "Make External IDs 2 primary", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Replace External IDs 1", exact: true })
    .click();
  await dialog
    .getByRole("textbox", { name: "External id", exact: true })
    .first()
    .fill("C");
  await save();
  expect(await stored()).toEqual([
    { code: "B", primary: true },
    { code: "C", primary: false },
  ]);

  await edit.click();
  // A combined Add/Replace need not preserve saved-row order.
  await identifiers
    .locator("div")
    .filter({ has: page.getByText("C", { exact: true }) })
    .filter({
      has: page.getByRole("button", { name: /^Remove External IDs \d+$/ }),
    })
    .getByRole("button", { name: /^Remove External IDs \d+$/ })
    .click();
  await save();
  expect(await stored()).toEqual([{ code: "B", primary: true }]);
});

test("vendor agent hints are edited with the generic structured editor", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  const vendor = await createEntityFixture(page, "vendor", {
    name: `Example supplier ${Date.now()}`,
  });
  await gotoAuthenticatedPage(page, `/vendors/${vendor.id}`);
  const edit = page.getByRole("button", { name: "Edit Vendor", exact: true });
  const dialog = page.getByRole("dialog", { name: "Edit Vendor" });

  await edit.click();
  await dialog
    .getByRole("textbox", { name: "Orders list url" })
    .fill("https://example.test/orders");
  await dialog.getByRole("button", { name: "Add note" }).click();
  await dialog.getByRole("textbox", { name: "Note 1" }).fill("Sign in first");
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(dialog).toBeHidden();

  await edit.click();
  await expect(
    dialog.getByRole("textbox", { name: "Orders list url" }),
  ).toHaveValue("https://example.test/orders");
  await expect(dialog.getByRole("textbox", { name: "Note 1" })).toHaveValue(
    "Sign in first",
  );
});
