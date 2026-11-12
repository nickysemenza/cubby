import type { Page } from "@playwright/test";

import {
  closePopovers,
  escapeRegExp,
  gotoAuthenticatedPage,
  uniqueName,
} from "./support/e2e-helpers";
import { expect, test } from "./support/e2e-test";
import { createEntityFixture } from "./fixtures/core";
import { dispatchOperations } from "./support/dispatch-wire";

const inputText = (input: unknown): string => JSON.stringify(input) ?? "";

/** Open the Filters panel on one (inactive) filter's editor. */
const openFilter = async (page: Page, label: string) => {
  await page.getByRole("button", { name: "Filters", exact: true }).click();
  await page.getByRole("button", { name: label, exact: true }).click();
};

/**
 * Pick a row from the open editor's inline list, searching first when the
 * list is long enough to offer search; the pick applies at once.
 */
const pickInline = async (page: Page, label: string, option: string) => {
  const search = page.getByRole("combobox", { name: `Filter ${label}` });
  const choice = page
    .getByRole("option", { name: new RegExp(`^${escapeRegExp(option)}`) })
    .first();
  // A short roster's combobox is a read-only keyboard input, not a search.
  // Wait until either the searchable input can accept a query or the choice
  // is already in the short roster. A shared database can make the search
  // input appear after the editor first renders.
  let searchable = false;
  await expect
    .poll(async () => {
      searchable = await search.isEditable().catch(() => false);
      return searchable || (await choice.isVisible().catch(() => false));
    })
    .toBe(true);
  if (searchable) {
    await expect(search).toBeEditable();
    await search.fill(option);
    await expect(search).toHaveValue(option);
  }
  await expect(choice).toBeVisible();
  await choice.click();
};

// Failure mode: the server takes one value across Email's Purchase, Vendor
// and Vendor account scopes, but the menu let a person combine them into a
// list query that always failed.
test("picking one Email scope replaces the other", async ({
  page,
}, testInfo) => {
  const storeName = uniqueName(testInfo, "Scope Store");
  const memberName = uniqueName(testInfo, "Scope Member");
  const store = await createEntityFixture(page, "vendor", { name: storeName });
  const member = await createEntityFixture(page, "ledgerParty", {
    name: memberName,
    kind: "member",
  });
  const account = await createEntityFixture(page, "vendorAccount", {
    vendorId: store.id,
    ledgerPartyId: member.id,
  });
  const pick = async (label: string, option: string) => {
    await openFilter(page, label);
    await pickInline(page, label, option);
    await closePopovers(page);
  };

  await gotoAuthenticatedPage(page, "/emails");
  await pick("Vendor", storeName);
  await expect(
    page.getByRole("button", { name: `Vendor: ${storeName}`, exact: true }),
  ).toBeVisible();

  // The request, not the response: picking rewrites the URL, and Playwright
  // cannot read a response body after that navigation, which failed this
  // test intermittently.
  const scoped = page.waitForRequest((request) =>
    dispatchOperations(request).some((item) => {
      const body = inputText(item.input);
      return (
        body.includes('"vendorAccountId"') &&
        body.includes(account.id) &&
        !body.includes('"vendorId"')
      );
    }),
  );
  await pick("Vendor account", `${storeName} · ${memberName}`);
  await scoped;
  await expect(
    page.getByRole("button", { name: /^Vendor account: / }).first(),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: `Vendor: ${storeName}`, exact: true }),
  ).toHaveCount(0);
  const search = new URL(page.url()).searchParams;
  expect(search.get("vendorAccountId")).toBe(account.id);
  expect(search.has("vendorId")).toBe(false);
});

// Failure mode: an embedded list built its Filters-menu reference pickers
// from caller-supplied rosters, so Linked transactions (which supplies none)
// offered an Account picker with nothing in it.
test("Linked transactions reference pickers load their rosters", async ({
  page,
}, testInfo) => {
  const accountName = uniqueName(testInfo, "Linked Card");
  const { id: accountId } = await createEntityFixture(
    page,
    "financialAccount",
    {
      name: accountName,
      identity: { kind: "credit_card", network: "visa" },
    },
  );
  const { id: vendorId } = await createEntityFixture(page, "vendor", {
    name: uniqueName(testInfo, "Linked Store"),
  });
  const { id: purchaseId } = await createEntityFixture(page, "purchase", {
    vendorId,
    date: "2026-09-10",
  });
  await createEntityFixture(page, "financialTransaction", {
    accountId,
    amount: 12,
    merchant: uniqueName(testInfo, "Linked charge"),
    kind: "purchase",
    status: "posted",
    postedDate: "2026-09-10",
    purchaseId,
  });

  await gotoAuthenticatedPage(
    page,
    `/purchases/${purchaseId}#financial-settlement`,
  );
  const linked = page.getByLabel("Linked transactions", { exact: true });
  await expect(linked).toBeVisible();
  const workbench = page
    .locator("div")
    .filter({ has: linked })
    .filter({ has: page.getByRole("button", { name: "Filters", exact: true }) })
    .last();
  await workbench.getByRole("button", { name: "Filters", exact: true }).click();
  await page.getByRole("button", { name: "Account", exact: true }).click();
  const picker = page.getByRole("combobox", { name: "Filter Account" });
  await picker.click();
  await picker.fill(accountName);
  await expect(
    page.getByRole("option", { name: new RegExp(accountName) }),
  ).toBeVisible();
});

// Failure mode: with a preset picked, the first typed digit of a custom bound
// changed the bounds editor's key from the preset to "bounds", remounting the
// input mid-typing so focus and every later digit were lost.
test("typing a bound after picking a preset keeps every digit", async ({
  page,
}) => {
  const param = () => new URL(page.url()).searchParams.get("purchaseCount");
  await gotoAuthenticatedPage(page, "/vendors");
  await openFilter(page, "Purchase count");
  await page.getByRole("option", { name: /^5\+ purchases/ }).click();
  await expect.poll(param).toBe('"5"');
  // The editor reflects the committed route value once the selected preset
  // updates; wait for that controlled state before changing the bounds.
  await expect(
    page.getByRole("option", { name: /^5\+ purchases/ }),
  ).toHaveAttribute("aria-selected", "true");
  // The strip's chip (the open panel row shares its name).
  const chip = page
    .getByRole("button", {
      name: "Purchase count: 5+ purchases",
      exact: true,
    })
    .first();
  await expect(chip).toBeVisible();

  const min = page.getByRole("textbox", { name: "Purchase count minimum" });
  await expect(min).toBeVisible();
  await min.click();
  await expect(min).toBeFocused();
  await min.pressSequentially("12");
  await expect(min).toHaveValue("12");
  await expect(min).toBeFocused();
  await expect.poll(param).toBe("12..");
});
