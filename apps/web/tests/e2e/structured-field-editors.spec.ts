import { and, asc, eq } from "drizzle-orm";
import { entityExternalId, financialAccount } from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/db/helpers";
import { gotoAuthenticatedPage } from "./support/e2e-helpers";
import { expect, test } from "./support/e2e-test";
import { createEntityFixture, getFixtureDb } from "./fixtures/core";

// The generic structured-value editor crosses the generated schema, the form, and the server's
// own validation: each flow below fails if any of the three drifts.
test("Product identifier edits preserve additions and apply explicit identity actions", async ({
  page,
}) => {
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
  await dialog
    .getByRole("button", { name: "Remove External IDs 2", exact: true })
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

test("a new account must choose its identity kind instead of getting a default", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  const name = `Example card ${Date.now()}`;
  await gotoAuthenticatedPage(
    page,
    `/financial-accounts?create=true&searchQuery=${encodeURIComponent(name)}`,
  );
  const dialog = page.getByRole("dialog", { name: "New Account" });
  await dialog.getByRole("textbox", { name: "Name", exact: true }).fill(name);

  const identity = dialog.getByRole("combobox", { name: "Identity" });
  await expect(identity).toHaveText(/^Choose/);
  await expect(dialog.getByRole("textbox", { name: "Issuer" })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Create" }).click();
  // The form refuses an account with no identity, and the dialog stays open.
  await expect(dialog).toBeVisible();

  await identity.click();
  await page.getByRole("option", { name: "Credit card" }).click();
  await dialog
    .getByRole("textbox", { name: "Issuer" })
    .fill("Example Credit Union");
  await dialog.getByRole("button", { name: "Add card number" }).click();
  await dialog.getByRole("textbox", { name: "Last 4" }).fill("4242");
  await dialog.getByRole("combobox", { name: "Kind" }).click();
  await page.getByRole("option", { name: "Primary" }).click();
  await dialog.getByRole("button", { name: "Create" }).click();
  await expect(dialog).toBeHidden();
  const stored = await getDb(getFixtureDb()).query.financialAccount.findFirst({
    where: and(eq(financialAccount.name, name), notDeleted(financialAccount)),
  });
  expect(stored).toMatchObject({
    identity: { kind: "credit_card", issuer: "Example Credit Union" },
    cardNumbers: [{ last4: "4242", kind: "primary" }],
  });
});

// Tester Army (web) found the Edit dialog refusing a source-claim description edit with
// "Invalid input at sourceClaims" before any request left the browser.
test("an expense's source claim description is edited without losing the claim", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  const expense = await createEntityFixture(page, "expense", {
    name: `Example claim expense ${Date.now()}`,
    cost: 10,
    trade: "other",
    sourceClaims: [
      {
        source: "example-provider",
        providerId: "example-row-1",
        normalizedEvidence: {
          amount: 10,
          occurredOn: "2026-08-20",
          description: "Example claim evidence",
          context: null,
          disambiguator: null,
        },
        reconciliation: { decision: "amounts_match" },
      },
    ],
  });
  await gotoAuthenticatedPage(page, `/expenses/${expense.id}`);
  const dialog = page.getByRole("dialog", { name: "Edit Expense" });
  const edit = page.getByRole("button", { name: "Edit Expense", exact: true });
  await edit.click();
  await dialog
    .getByRole("textbox", { name: "Description" })
    .fill("Example claim evidence revised");
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(dialog).toBeHidden();

  await edit.click();
  await expect(
    dialog.getByRole("textbox", { name: "Description" }),
  ).toHaveValue("Example claim evidence revised");
});
