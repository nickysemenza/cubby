import {
  gotoAuthenticatedPage,
  reloadAuthenticatedPage,
  uniqueName,
} from "./support/e2e-helpers";
import { expect, test } from "./support/e2e-test";
import { createEntityFixture } from "./fixtures/core";

// Failure mode: Vendor Account's `ledgerPartyId` filter was URL-only, so its
// Ledger party column offered no filter and only a hand-typed param could
// narrow by member. It must be pickable from the Filters menu, narrow the
// rows through the server, survive a reload as a deep link, and clear from
// the same bar.
test("vendor accounts filter by member from the Filters menu", async ({
  page,
}, testInfo) => {
  const storeName = uniqueName(testInfo, "Filter Store");
  const store = await createEntityFixture(page, "vendor", { name: storeName });
  const memberWithAccount = async (label: string) => {
    const name = uniqueName(testInfo, `${label} Member`);
    const { id } = await createEntityFixture(page, "ledgerParty", {
      name,
      kind: "member",
    });
    await createEntityFixture(page, "vendorAccount", {
      vendorId: store.id,
      ledgerPartyId: id,
    });
    return { id, name };
  };
  const alder = await memberWithAccount("Alder");
  const birch = await memberWithAccount("Birch");
  const account = (member: { name: string }) =>
    page.getByRole("link", {
      name: `${storeName} · ${member.name}`,
      exact: true,
    });

  await gotoAuthenticatedPage(page, "/vendor-accounts");
  await expect(account(alder)).toBeVisible();
  await expect(account(birch)).toBeVisible();

  await page.getByRole("button", { name: "Filters", exact: true }).click();
  await page
    .getByRole("button", { name: "Ledger party: any", exact: true })
    .click();
  const picker = page.getByRole("combobox", { name: "Filter Ledger party" });
  await picker.click();
  await picker.fill(alder.name);
  await page.getByRole("option", { name: alder.name }).click();
  await picker.click();
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await page.keyboard.press("Escape");

  const chip = page.getByRole("button", {
    name: `Ledger party: ${alder.name}`,
    exact: true,
  });
  await expect(chip).toBeVisible();
  await expect(account(alder)).toBeVisible();
  await expect(account(birch)).toHaveCount(0);
  expect(new URL(page.url()).searchParams.get("ledgerPartyId")).toBe(alder.id);

  await reloadAuthenticatedPage(page);
  await expect(chip).toBeVisible();
  await expect(account(birch)).toHaveCount(0);

  await page.getByRole("button", { name: "Clear 1", exact: true }).click();
  await expect(account(birch)).toBeVisible();
  expect(new URL(page.url()).searchParams.has("ledgerPartyId")).toBe(false);
});
