import type { StatementRowInput } from "@cubby/schemas/statement-row";

import { createEntityFixture } from "./fixtures/core";
import { gotoAuthenticatedPage } from "./support/e2e-helpers";
import { expect, test } from "./support/e2e-test";
import { startOperation } from "./support/start-operation";

test("statement suggestions accept a clean supersede by group and dismiss another", async ({
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
  const hold = `${tag} HOLD`;
  const grocer = `${tag} GROCER`;
  const cafe = `${tag} CAFE`;
  const record = (fingerprint: string, rows: Partial<StatementRowInput>[]) =>
    startOperation(page.request, "statementRow.record", {
      import: {
        source: "monarch",
        label: `${fingerprint}.csv`,
        fingerprint,
        dateKind: "posted",
      },
      rows: rows.map((row) => ({
        accountDescriptor: tag,
        merchant: null,
        providerStatus: "posted",
        ...row,
      })),
    });
  const recorded = await record(tag, [
    {
      rowPosition: 1,
      statementDate: "2026-05-04",
      providerAmount: -42.5,
      rawDescription: hold,
      sourceCategory: "Groceries",
      providerStatus: "pending",
    },
    {
      // No category: only the sign speaks to the kind, so it needs review.
      rowPosition: 2,
      statementDate: "2026-05-11",
      providerAmount: -17.25,
      rawDescription: cafe,
      sourceCategory: null,
    },
  ]);
  expect(recorded.ok(), await recorded.text()).toBe(true);

  // No background queue in E2E: the client pages the refresh inline.
  const refresh = async () => {
    await gotoAuthenticatedPage(page, "/statement-rows?tab=suggestions");
    await page
      .getByRole("button", { name: "Refresh suggestions" })
      .first()
      .click();
    await expect(page.getByText(/Refreshed: /)).toBeVisible({
      timeout: 60_000,
    });
  };
  await refresh();
  const group = page
    .getByRole("table", { name: "Suggestion groups" })
    .getByRole("row")
    .filter({ hasText: tag });
  await expect(group).toHaveCount(1);
  // Without decision labels no create's kind is agreed, so the hold is
  // reviewed on its own.
  await expect(
    group.getByRole("button", { name: "Accept 0 clean" }),
  ).toBeDisabled();
  await group.click();
  const pending = page.getByRole("listitem", {
    name: `Suggestion for ${hold}`,
  });
  await pending.getByRole("button", { name: "Accept", exact: true }).click();
  await expect(pending).toHaveCount(0);

  const posted = await record(`${tag}-posted`, [
    {
      rowPosition: 1,
      statementDate: "2026-05-06",
      providerAmount: -42.5,
      rawDescription: grocer,
      sourceCategory: "Groceries",
    },
  ]);
  expect(posted.ok(), await posted.text()).toBe(true);
  // Settling the recorded hold at its exact amount is clean without labels.
  await refresh();
  await group.getByRole("button", { name: "Accept 1 clean" }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Accept 1" })
    .click();
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
