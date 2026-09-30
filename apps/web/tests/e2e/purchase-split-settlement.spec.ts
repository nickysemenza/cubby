import { sql } from "drizzle-orm";
import { purchaseSettlementCandidatesOut } from "@cubby/schemas/purchase";
import superjson from "superjson";
import { z } from "zod";

import { superJsonResultSchema } from "~/lib/superjson-wire";
import { getDb } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import {
  createEvidenceHarnessContext,
  seedSplitSettlementPrerequisite,
} from "./e2e-fixtures";
import { gotoAuthenticatedPage } from "./e2e-helpers";
import { expect, test } from "./e2e-test";

test("finds settlement beyond 200 newer nonmatches and allocates only after review", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const merchant = `Synthetic Outfitters ${Date.now()}`;
  const seed = await seedSplitSettlementPrerequisite(page, merchant);
  const { db } = await createEvidenceHarnessContext(page);
  // These irrelevant rows sort ahead of the actual charge in the generic
  // transaction list. Candidate predicates must run before the result limit.
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
  await insertWithShortcode(db, "financialTransaction", {
    accountId: seed.transaction.accountId,
    kind: "purchase",
    status: "posted",
    amount: 42.5,
    merchant: `${merchant} exact charge`,
    postedDate: "2026-09-13",
  });
  await insertWithShortcode(db, "financialTransaction", {
    accountId: seed.transaction.accountId,
    kind: "refund",
    status: "posted",
    amount: -15,
    merchant: `${merchant} refund`,
    postedDate: "2026-09-14",
  });
  for (const [name, kind, date, deletedAt] of [
    ["transfer", "account_transfer", "2026-09-10", null],
    ["outside window", "purchase", "2026-07-01", null],
    ["deleted", "purchase", "2026-09-10", new Date()],
  ] as const)
    await insertWithShortcode(db, "financialTransaction", {
      accountId: seed.transaction.accountId,
      kind,
      status: "posted",
      amount: 42.5,
      merchant: `${merchant} ${name}`,
      postedDate: date,
      deletedAt,
    });
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
    VALUES (${allocated.id}, ${seed.first.id}, 42.5)
  `);
  await insertWithShortcode(db, "financialTransaction", {
    accountId: seed.transaction.accountId,
    kind: "purchase",
    status: "void",
    amount: 42.5,
    merchant: `${merchant} void`,
    postedDate: "2026-09-10",
  });
  await gotoAuthenticatedPage(
    page,
    `/purchases/${seed.first.shortcode}`,
    page.getByRole("button", { name: "Match statement activity" }),
  );
  const advisoryResponse = page.waitForResponse((response) => {
    const request = response.request();
    return (
      response.url().endsWith("/api/browser/dispatch") &&
      request.method() === "POST" &&
      z
        .object({ json: z.object({ operation: z.string() }) })
        .parse(request.postDataJSON()).json.operation ===
        "purchase.settlementCandidates"
    );
  });
  await page.getByRole("button", { name: "Match statement activity" }).click();
  const response = await advisoryResponse;
  expect(response.status()).toBe(200);
  const body = z
    .object({ ok: z.literal(true), data: purchaseSettlementCandidatesOut })
    .parse(
      superjson.deserialize(superJsonResultSchema.parse(await response.json())),
    );
  expect(body.data.advisory).toBe(true);
  const dialog = page.getByRole("dialog", { name: "Match statement activity" });
  await expect(dialog.getByText("$91.00")).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: /Synthetic date fallback merchant/ }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: /Synthetic unrelated merchant/ }),
  ).toHaveCount(0);
  await expect(
    dialog.getByRole("button").filter({ hasText: /Synthetic/ }),
  ).toHaveText([
    /exact charge/,
    /Synthetic date fallback merchant/,
    new RegExp(merchant),
    /refund/,
  ]);
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
    page.getByRole("row", { name: /\$42\.50of \$91\.00/ }),
  ).toBeVisible();
  await gotoAuthenticatedPage(
    page,
    `/purchases/${seed.second.shortcode}`,
    page.getByRole("row", { name: /\$48\.50of \$91\.00/ }),
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
});
