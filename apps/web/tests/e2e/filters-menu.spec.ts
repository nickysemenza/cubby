import type { Page, Response } from "@playwright/test";
import { z } from "zod";

import {
  closePopovers,
  gotoAuthenticatedPage,
  reloadAuthenticatedPage,
  selectComboboxItem,
  uniqueName,
} from "./support/e2e-helpers";
import { expect, test } from "./support/e2e-test";
import { createEntityFixture } from "./fixtures/core";
import { dispatchOperations, operationResult } from "./support/dispatch-wire";

const inputText = (input: unknown): string => JSON.stringify(input) ?? "";

/** The next dispatched operation whose input matches, answered `ok`. */
const succeedsWith = (page: Page, matches: (input: string) => boolean) =>
  page
    .waitForResponse((response) =>
      dispatchOperations(response.request()).some((item) =>
        matches(inputText(item.input)),
      ),
    )
    .then(async (response: Response) => {
      const item = dispatchOperations(response.request()).find((candidate) =>
        matches(inputText(candidate.input)),
      );
      if (!item) throw new Error("no matching operation");
      return operationResult(response, item.operation, z.unknown());
    });

// Failure mode: typed `ext-a, ext-b` reached the server as one value, a
// reload of the same URL decoded two, and the editor showed only the first.
test("typed id values keep one meaning through entry, reload and edit", async ({
  page,
}) => {
  await gotoAuthenticatedPage(page, "/financial-transactions");
  await page.getByRole("button", { name: "Filters", exact: true }).click();
  await page.getByRole("button", { name: /^External id: any$/i }).click();
  const input = page.getByRole("textbox", { name: /^Filter External id$/i });
  const typed = succeedsWith(page, (body) =>
    body.includes('["ext-a","ext-b"]'),
  );
  await input.fill("ext-a, ext-b");
  await typed;
  await expect
    .poll(() => new URL(page.url()).searchParams.get("externalId"))
    .toBe("ext-a,ext-b");
  await closePopovers(page);

  const chip = page.getByRole("button", {
    name: /^External id: ext-a or ext-b$/i,
  });
  await reloadAuthenticatedPage(page);
  await expect(chip).toBeVisible();
  await chip.click();
  await expect(input).toHaveValue("ext-a, ext-b");
  const edited = succeedsWith(page, (body) =>
    body.includes('["ext-a","ext-b","ext-c"]'),
  );
  await input.press("End");
  await input.pressSequentially(", ext-c");
  await edited;
  await expect
    .poll(() => new URL(page.url()).searchParams.get("externalId"))
    .toBe("ext-a,ext-b,ext-c");
});

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
    await page.getByRole("button", { name: "Filters", exact: true }).click();
    await page
      .getByRole("button", { name: new RegExp(`^${label}: `) })
      .last()
      .click();
    await selectComboboxItem(
      page,
      page.getByRole("combobox", { name: `Filter ${label}` }),
      option,
    );
    await closePopovers(page);
  };

  await gotoAuthenticatedPage(page, "/emails");
  await pick("Vendor", storeName);
  await expect(
    page.getByRole("button", { name: `Vendor: ${storeName}`, exact: true }),
  ).toBeVisible();

  const scoped = succeedsWith(
    page,
    (body) =>
      body.includes('"vendorAccountId"') &&
      body.includes(account.id) &&
      !body.includes('"vendorId"'),
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
      identity: { kind: "credit_card", issuer: null, network: "visa" },
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

  await gotoAuthenticatedPage(page, `/purchases/${purchaseId}`);
  const linked = page.getByLabel("Linked transactions", { exact: true });
  await expect(linked).toBeVisible();
  const workbench = page
    .locator("div")
    .filter({ has: linked })
    .filter({ has: page.getByRole("button", { name: /: any$/ }) })
    .last();
  const accountChip = workbench.getByRole("button", { name: /^Account: / });
  if ((await accountChip.count()) === 0)
    await workbench.getByRole("button", { name: "More", exact: true }).click();
  await page
    .getByRole("button", { name: /^Account: / })
    .last()
    .click();
  const picker = page.getByRole("combobox", { name: "Filter Account" });
  await picker.click();
  await picker.fill(accountName);
  await expect(
    page.getByRole("option", { name: new RegExp(accountName) }),
  ).toBeVisible();
});

// Failure mode: the codec split every picked value on commas, so the tag
// `quick, easy` reached the server as two tags and decoded as two on reload.
test("a picked tag containing a comma stays one tag through URL and reload", async ({
  page,
}, testInfo) => {
  const tag = `${uniqueName(testInfo, "quick")}, easy`;
  const tagged = uniqueName(testInfo, "Comma Tag Recipe");
  const untagged = uniqueName(testInfo, "Untagged Recipe");
  await createEntityFixture(page, "recipe", { name: tagged, tags: [tag] });
  await createEntityFixture(page, "recipe", { name: untagged });
  const recipe = (name: string) =>
    page.getByRole("link", { name, exact: true });

  await gotoAuthenticatedPage(page, "/recipes");
  await page.getByRole("button", { name: "Filters", exact: true }).click();
  await page
    .getByRole("button", { name: /^Tags: / })
    .last()
    .click();
  const picker = page.getByRole("combobox", { name: "Filter Tags" });
  await picker.click();
  await picker.fill(tag);
  await page.getByRole("option", { name: tag, exact: true }).click();
  await picker.click();
  const filtered = succeedsWith(page, (body) =>
    body.includes(JSON.stringify([tag])),
  );
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await filtered;
  await closePopovers(page);
  await expect(recipe(tagged)).toBeVisible();
  await expect(recipe(untagged)).toHaveCount(0);

  // Split into `quick` and `easy`, the reloaded query would match nothing.
  await reloadAuthenticatedPage(page);
  await expect(
    page.getByRole("button", { name: `Tags: ${tag}`, exact: true }),
  ).toBeVisible();
  await expect(recipe(tagged)).toBeVisible();
  await expect(recipe(untagged)).toHaveCount(0);
});

// Failure mode: landing on the `?parentTaskId=` alias then picking another
// parent kept two states, and the alias's stale value won the request.
test("editing Parent task after landing on its deep-link alias", async ({
  page,
}, testInfo) => {
  const task = async (label: string, parentTaskId?: string) => {
    const name = uniqueName(testInfo, label);
    const { id } = await createEntityFixture(page, "task", {
      name,
      trade: "other",
      ...(parentTaskId ? { parentTaskId } : {}),
    });
    return { id, name };
  };
  const parentA = await task("Alias Parent A");
  const parentB = await task("Alias Parent B");
  const childA = await task("Alias Child A", parentA.id);
  const childB = await task("Alias Child B", parentB.id);
  const row = (name: string) => page.getByRole("link", { name, exact: true });

  await gotoAuthenticatedPage(page, `/tasks?parentTaskId=${parentA.id}`);
  await expect(row(childA.name)).toBeVisible();
  await expect(row(childB.name)).toHaveCount(0);
  // The alias is read into the Parent task filter and the URL moves to its key.
  await expect
    .poll(() => new URL(page.url()).searchParams.get("parentTask"))
    .toBe(parentA.id);
  expect(new URL(page.url()).searchParams.has("parentTaskId")).toBe(false);

  await page
    .getByRole("button", { name: `Parent task: ${parentA.name}`, exact: true })
    .click();
  const picker = page.getByRole("combobox", { name: "Filter Parent task" });
  for (const parent of [parentA, parentB]) {
    await picker.click();
    await picker.fill(parent.name);
    await page.getByRole("option", { name: parent.name, exact: true }).click();
  }
  await picker.click();
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await closePopovers(page);

  await expect(row(childB.name)).toBeVisible();
  await expect(row(childA.name)).toHaveCount(0);
  expect(new URL(page.url()).searchParams.get("parentTask")).toBe(parentB.id);
});
