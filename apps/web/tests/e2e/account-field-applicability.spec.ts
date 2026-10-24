import { createFixtureGraph, ensureMemberParty } from "./fixtures/core";
import { gotoAuthenticatedPage } from "./support/e2e-helpers";
import { expect, test } from "./support/e2e-test";

test("explains inapplicable account fields without offering edits", async ({
  page,
}) => {
  const owner = await ensureMemberParty(page, "Synthetic account member");
  const bank = await createFixtureGraph(page, async (create) =>
    create("financialAccount", {
      name: "Synthetic applicability checking",
      identity: { kind: "bank_account", accountType: "checking" },
      ledgerPartyId: owner.shortcode,
    }),
  );
  await gotoAuthenticatedPage(page, `/financial-accounts/${bank.id}`);
  const explanations = page.getByRole("note", {
    name: "Not applicable. Only applies to credit-card accounts.",
  });
  await expect(explanations.first()).toBeVisible();
  await explanations.first().focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(explanations.first()).toBeFocused();
  await expect(
    page.getByText("Only applies to credit-card accounts.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Provisional", { exact: true })).toHaveCount(0);
  await gotoAuthenticatedPage(
    page,
    "/financial-accounts?q=Synthetic%20applicability%20checking",
  );
  await expect(
    page
      .getByRole("link", {
        name: "Synthetic applicability checking",
        exact: true,
      })
      .first(),
  ).toBeVisible();
  await expect(
    page
      .getByRole("note", {
        name: "Not applicable. Only applies to credit-card accounts.",
      })
      .first(),
  ).toBeVisible();
  await expect(
    page.getByRole("columnheader", { name: "Provisional", exact: true }),
  ).toHaveCount(0);
});
