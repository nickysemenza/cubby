import { sql } from "drizzle-orm";
import { purchaseSettlementCandidatesOut } from "@cubby/schemas/purchase";
import { SETTLEMENT_CANDIDATE_LIMIT } from "@cubby/schemas/financial-transaction";

import { getDb } from "~/server/db/helpers";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

import { createEvidenceHarnessContext } from "./fixtures/core";
import { seedSplitSettlementPrerequisite } from "./fixtures/finance";
import {
  gotoAuthenticatedPage,
  gotoDetailActions,
} from "./support/e2e-helpers";
import { expect, test } from "./support/e2e-test";
import { dispatchesOperation, operationResult } from "./support/dispatch-wire";

// Failure modes: a generic transaction-page limit hides the best evidence,
// broad candidates overflow the wire schema, residual allocations disappear,
// exhausted unrelated payments reappear, or advisory reads change the ledger.
test("bounds broad settlement candidates after ranking and allocates only after review", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const merchant = `Synthetic Outfitters ${Date.now()}`;
  const seed = await seedSplitSettlementPrerequisite(page, merchant);
  const { db } = await createEvidenceHarnessContext(page);
  // These weaker candidates sort ahead of the actual charge in the generic
  // transaction list. Eligibility and rank must run before the advisory limit.
  for (let offset = 0; offset < 208; offset += 8)
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        insertWithShortcode(db, "financialTransaction", {
          accountId: seed.transaction.accountId,
          kind: "purchase",
          status: "posted",
          amount: 1,
          merchant: `Synthetic unrelated merchant ${offset + index}`,
          postedDate: "2026-09-13",
        }),
      ),
    );
  const undatedPosting = await insertWithShortcode(db, "financialTransaction", {
    accountId: seed.transaction.accountId,
    kind: "purchase",
    status: "pending",
    amount: 42.5,
    merchant: "Synthetic date fallback merchant",
    transactionDate: "2026-09-10",
  });
  const exactCharge = await insertWithShortcode(db, "financialTransaction", {
    accountId: seed.transaction.accountId,
    kind: "purchase",
    status: "posted",
    amount: 42.5,
    merchant: `${merchant} exact charge`,
    postedDate: "2026-09-13",
  });
  const refund = await insertWithShortcode(db, "financialTransaction", {
    accountId: seed.transaction.accountId,
    kind: "refund",
    status: "posted",
    amount: -15,
    merchant: `${merchant} refund`,
    postedDate: "2026-09-14",
  });
  const excluded = [];
  for (const [name, kind, date, deletedAt] of [
    ["transfer", "account_transfer", "2026-09-10", null],
    ["outside window", "purchase", "2026-07-01", null],
    ["deleted", "purchase", "2026-09-10", new Date()],
  ] as const)
    excluded.push(
      await insertWithShortcode(db, "financialTransaction", {
        accountId: seed.transaction.accountId,
        kind,
        status: "posted",
        amount: 42.5,
        merchant: `${merchant} ${name}`,
        postedDate: date,
        deletedAt,
      }),
    );
  const allocated = await insertWithShortcode(db, "financialTransaction", {
    accountId: seed.transaction.accountId,
    kind: "purchase",
    status: "posted",
    amount: 42.5,
    merchant: `${merchant} allocated`,
    postedDate: "2026-09-10",
  });
  await getDb(db).execute(sql`
    INSERT INTO "FinancialTransactionAllocation" ("transactionId", "purchaseId", amount)
    VALUES (${allocated.id}, ${seed.second.id}, 42.5)
  `);
  excluded.push(allocated);
  const partial = await insertWithShortcode(db, "financialTransaction", {
    accountId: seed.transaction.accountId,
    kind: "purchase",
    status: "posted",
    amount: 57.5,
    merchant: "Synthetic processor alias",
    postedDate: "2026-10-20",
  });
  await getDb(db).execute(sql`
    INSERT INTO "FinancialTransactionAllocation" ("transactionId", "purchaseId", amount)
    VALUES (${partial.id}, ${seed.second.id}, 15)
  `);
  excluded.push(
    await insertWithShortcode(db, "financialTransaction", {
      accountId: seed.transaction.accountId,
      kind: "purchase",
      status: "void",
      amount: 42.5,
      merchant: `${merchant} void`,
      postedDate: "2026-09-10",
    }),
  );
  const acceptedAllocations = () =>
    getDb(db).execute(sql`
    SELECT "transactionId", "purchaseId", amount FROM "FinancialTransactionAllocation"
    WHERE "transactionId" IN (${allocated.id}, ${partial.id}) AND "deletedAt" IS NULL
    ORDER BY "transactionId", "purchaseId"
  `);
  const acceptedBefore = await acceptedAllocations();
  await gotoDetailActions(
    page,
    `/purchases/${seed.first.shortcode}`,
    page.getByRole("button", { name: "Match statement activity" }),
  );
  const actions = page.getByRole("group", {
    name: "Entity actions",
    exact: true,
  });
  await expect(
    actions.getByRole("button", {
      name: "Match statement activity",
      exact: true,
    }),
  ).toBeVisible();
  // Consume the body when the response arrives: click may wait for
  // navigation, after which Chromium can discard the prior response body.
  const [data] = await Promise.all([
    page
      .waitForResponse((response) =>
        dispatchesOperation(
          response.request(),
          "purchase.settlementCandidates",
        ),
      )
      .then(async (response) => {
        expect(response.status()).toBe(200);
        return operationResult(
          response,
          "purchase.settlementCandidates",
          purchaseSettlementCandidatesOut,
        );
      }),
    page.getByRole("button", { name: "Match statement activity" }).click(),
  ]);
  expect(data.advisory).toBe(true);
  expect(data.candidates).toHaveLength(SETTLEMENT_CANDIDATE_LIMIT);
  expect(
    data.candidates.slice(0, 5).map((candidate) => candidate.transaction.id),
  ).toEqual([
    exactCharge.shortcode,
    undatedPosting.shortcode,
    partial.shortcode,
    seed.transaction.shortcode,
    refund.shortcode,
  ]);
  const candidateIds = data.candidates.map(
    (candidate) => candidate.transaction.id,
  );
  for (const transaction of excluded)
    expect(candidateIds).not.toContain(transaction.shortcode);
  const partialCandidate = data.candidates.find(
    (candidate) => candidate.transaction.id === partial.shortcode,
  );
  expect(partialCandidate).toMatchObject({
    days: 40,
    merchantMatches: false,
    exactAmount: true,
    nearAmount: false,
    conflicts: [],
    proposedAllocations: [
      { purchaseId: seed.second.shortcode, amount: "15.00" },
      { purchaseId: seed.first.shortcode, amount: "42.50" },
    ],
  });
  const dialog = page.getByRole("dialog", { name: "Match statement activity" });
  await expect(dialog.getByText("$91.00")).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: /Synthetic date fallback merchant/ }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: /Synthetic unrelated merchant/ }),
  ).toHaveCount(SETTLEMENT_CANDIDATE_LIMIT - 5);
  // Reviewing residual money keeps the already accepted allocation intact.
  await dialog
    .getByRole("button", { name: /Synthetic processor alias/ })
    .click();
  await expect(
    dialog.getByRole("textbox", { name: "Purchase code 1", exact: true }),
  ).toHaveValue(seed.second.shortcode);
  await expect(
    dialog.getByRole("spinbutton", { name: "Amount 1", exact: true }),
  ).toHaveValue("15.00");
  await expect(
    dialog.getByRole("textbox", { name: "Purchase code 2", exact: true }),
  ).toHaveValue(seed.first.shortcode);
  await expect(
    dialog.getByRole("spinbutton", { name: "Amount 2", exact: true }),
  ).toHaveValue("42.50");
  expect((await acceptedAllocations()).rows).toEqual(acceptedBefore.rows);
  const allocationsBeforeApproval = await getDb(db).execute(sql`
    SELECT count(*)::int AS count FROM "FinancialTransactionAllocation"
    WHERE "transactionId" IN (${seed.transaction.id}, ${undatedPosting.id})
      AND "deletedAt" IS NULL
  `);
  expect(allocationsBeforeApproval.rows).toEqual([{ count: 0 }]);
  const ledgerBeforeApproval = await getDb(db).execute(sql`
    SELECT count(*)::int AS count FROM "Expense"
    WHERE "purchaseId" IN (${seed.first.id}, ${seed.second.id})
      AND "deletedAt" IS NULL
  `);
  expect(ledgerBeforeApproval.rows).toEqual([{ count: 0 }]);
  await dialog.getByRole("button").filter({ hasText: "$91.00" }).click();
  await expect(
    dialog.getByRole("textbox", { name: "Purchase code 1" }),
  ).toHaveValue(seed.first.shortcode);
  await dialog
    .getByRole("textbox", { name: "Purchase code 2" })
    .fill(seed.second.shortcode);
  await dialog.getByRole("button", { name: "Save allocation" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("row", { name: /\$42\.50\s*of\s*\$91\.00/ }),
  ).toBeVisible();
  await gotoAuthenticatedPage(
    page,
    `/purchases/${seed.second.shortcode}`,
    page.getByRole("row", { name: /\$48\.50\s*of\s*\$91\.00/ }),
  );
  const reviewedAllocations = await getDb(db).execute(sql`
    SELECT "purchaseId", amount FROM "FinancialTransactionAllocation"
    WHERE "transactionId" = ${seed.transaction.id} AND "deletedAt" IS NULL
    ORDER BY amount
  `);
  expect(reviewedAllocations.rows).toEqual([
    { purchaseId: seed.first.id, amount: 42.5 },
    { purchaseId: seed.second.id, amount: 48.5 },
  ]);
  const ledgerAfterApproval = await getDb(db).execute(sql`
    SELECT count(*)::int AS count FROM "Expense"
    WHERE "purchaseId" IN (${seed.first.id}, ${seed.second.id})
      AND "deletedAt" IS NULL
  `);
  expect(ledgerAfterApproval.rows).toEqual(ledgerBeforeApproval.rows);
  expect((await acceptedAllocations()).rows).toEqual(acceptedBefore.rows);
});
