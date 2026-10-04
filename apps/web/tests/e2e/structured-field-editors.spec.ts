import { gotoAuthenticatedPage } from "./e2e-helpers";
import { expect, test } from "./e2e-test";
import { createEntityFixture } from "./fixtures-core";

// The generic structured-value editor crosses the generated schema, the form, and the server's
// own validation: each flow below fails if any of the three drifts.
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
  await gotoAuthenticatedPage(page, "/financial-accounts?create=true");
  const dialog = page.getByRole("dialog", { name: "New Account" });
  await dialog.getByRole("textbox", { name: "Name", exact: true }).fill(name);

  const identity = dialog.getByRole("combobox", { name: "Identity" });
  await expect(identity).toHaveValue("");
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
  const row = page.getByRole("row").filter({ hasText: name });
  await expect(row).toBeVisible();
  await expect(row).toContainText("Credit card");
});
