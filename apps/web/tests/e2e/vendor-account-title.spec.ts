import { eq } from "drizzle-orm";
import { getDb } from "~/server/db/helpers";
import { vendor } from "~/server/db/schema";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

import {
  gotoAuthenticatedPage,
  reloadAuthenticatedPage,
  selectComboboxItem,
  waitForFormHydration,
} from "./support/e2e-helpers";
import { expect, test } from "./support/e2e-test";
import { getFixtureDb } from "./fixtures/core";

// An account is named only by its Vendor and member: the form offers no
// label to type, and renaming the Vendor renames the account everywhere.
test("vendor accounts take their title from the current vendor and member", async ({
  page,
}) => {
  const db = getFixtureDb();
  const member = await insertWithShortcode(db, "ledgerParty", {
    name: "Synthetic Title Member",
    kind: "member",
  });
  const store = await insertWithShortcode(db, "vendor", {
    name: "Synthetic Title Store",
  });

  await gotoAuthenticatedPage(page, "/vendor-accounts?create=true");
  await waitForFormHydration(page);
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("combobox", { name: "Vendor", exact: true }),
  ).toBeVisible();
  await expect(dialog.getByRole("textbox", { name: "Label" })).toHaveCount(0);
  await selectComboboxItem(
    page,
    dialog.getByRole("combobox", { name: "Vendor", exact: true }),
    store.name,
  );
  await selectComboboxItem(
    page,
    dialog.getByRole("combobox", { name: "Ledger party", exact: true }),
    member.name,
  );
  await dialog.getByRole("button", { name: /^Create$/ }).click();
  await expect(dialog).not.toBeVisible();

  await gotoAuthenticatedPage(page, "/vendor-accounts");
  const title = (name: string) =>
    page.getByRole("link", { name: `${name} · ${member.name}`, exact: true });
  await expect(title(store.name)).toBeVisible();

  await getDb(db)
    .update(vendor)
    .set({ name: "Synthetic Renamed Store" })
    .where(eq(vendor.id, store.id));
  await reloadAuthenticatedPage(page);
  await expect(title("Synthetic Renamed Store")).toBeVisible();
  await expect(title(store.name)).toHaveCount(0);
});
