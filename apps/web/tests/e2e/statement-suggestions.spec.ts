import { createEntityFixture } from "./fixtures/core";
import { gotoAuthenticatedPage } from "./support/e2e-helpers";
import { expect, test } from "./support/e2e-test";
import { startOperation } from "./support/start-operation";

test("statement suggestions accept a clean create by group and dismiss another", async ({
  page,
}) => {
  test.slow();
  const tag = `synthetic-suggest-${Date.now()}`;
  await gotoAuthenticatedPage(page, "/statement-rows?tab=suggestions");
  await createEntityFixture(page, "financialAccount", {
    name: tag,
    identity: { kind: "credit_card", issuer: null, network: "visa" },
    sourceAliases: [{ source: "monarch", alias: tag, externalAccountId: null }],
  });
  const grocer = `${tag} GROCER`;
  const cafe = `${tag} CAFE`;
  const recorded = await startOperation(page.request, "statementRow.record", {
    import: {
      source: "monarch",
      label: `${tag}.csv`,
      fingerprint: tag,
      dateKind: "posted",
    },
    rows: [
      {
        // A spending category settles the kind by rule: a clean create.
        rowPosition: 1,
        accountDescriptor: tag,
        statementDate: "2026-05-04",
        providerAmount: -42.5,
        merchant: null,
        rawDescription: grocer,
        sourceCategory: "Groceries",
        providerStatus: "posted",
      },
      {
        // No category: only the sign speaks to the kind, so it needs review.
        rowPosition: 2,
        accountDescriptor: tag,
        statementDate: "2026-05-11",
        providerAmount: -17.25,
        merchant: null,
        rawDescription: cafe,
        sourceCategory: null,
        providerStatus: "posted",
      },
    ],
  });
  expect(recorded.ok(), await recorded.text()).toBe(true);

  // No background queue in E2E: the client pages the refresh inline.
  await page
    .getByRole("button", { name: "Refresh suggestions" })
    .first()
    .click();
  await expect(page.getByText(/Refreshed: /)).toBeVisible({ timeout: 60_000 });

  const group = page
    .getByRole("table", { name: "Suggestion groups" })
    .getByRole("row")
    .filter({ hasText: tag });
  await expect(group).toHaveCount(1);
  await group.getByRole("button", { name: "Accept 1 clean" }).click();
  await expect(page.getByText(/Accepted 1 of 1/)).toBeVisible();
  await expect(
    page.getByRole("list", { name: "Failed suggestions" }),
  ).toHaveCount(0);

  await group.click();
  const remaining = page.getByRole("listitem", {
    name: `Suggestion for ${cafe}`,
  });
  await expect(remaining).toBeVisible();
  await expect(
    page.getByRole("listitem", { name: `Suggestion for ${grocer}` }),
  ).toHaveCount(0);
  await remaining.getByRole("button", { name: "Dismiss" }).click();
  await expect(remaining).toHaveCount(0);
  await expect(group).toHaveCount(0);

  await gotoAuthenticatedPage(
    page,
    `/statement-rows?matchState=all&q=${encodeURIComponent(grocer)}`,
  );
  const row = page
    .getByRole("table", { name: "Statement Rows Table" })
    .getByRole("row")
    .filter({ hasText: grocer });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("Matched");
});
