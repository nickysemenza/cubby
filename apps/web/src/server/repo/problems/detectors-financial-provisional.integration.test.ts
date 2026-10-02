import { sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import type { Database } from "~/server/db";
import { loadDataQualities } from "~/server/repo/data-quality/hydrate";
import { getDb } from "~/server/repo/database-helpers";
import { replaceSettlementRefs } from "~/server/repo/entity-external-ids";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import { findProvisionalFinancialAccounts } from "./detectors-financial";

// Failure modes this guards:
//  - a provisional account that already carries a provider alias, or that
//    settles a statement-referenced transaction, being reported as unlinked;
//  - a soft-deleted statement transaction still counting as provider evidence;
//  - a non-provisional account (never receipt-minted) being reported.
describe("provisional financial accounts", () => {
  const ctx = withTestDb();
  let seq = 0;
  const label = (prefix: string) => `${prefix}-${(seq++).toString(36)}`;

  const account = (
    db: Database,
    overrides: {
      provisional?: boolean;
      sourceAliases?: {
        source: string;
        alias: string;
        externalAccountId: string | null;
      }[];
    } = {},
  ) =>
    insertWithShortcode(db, "financialAccount", {
      name: label("Card"),
      identity: { kind: "credit_card", issuer: null, network: "visa" },
      provisional: overrides.provisional ?? true,
      sourceAliases: overrides.sourceAliases ?? [],
    });

  const transaction = async (
    db: Database,
    accountId: Awaited<ReturnType<typeof account>>["id"],
    options: { refs?: boolean; deleted?: boolean } = {},
  ) => {
    const created = await insertWithShortcode(db, "financialTransaction", {
      accountId,
      kind: "purchase",
      status: "posted",
      amount: 12.5,
      postedDate: "2026-09-01",
      merchant: label("Merchant"),
      deletedAt: options.deleted ? new Date() : null,
    });
    if (options.refs)
      await getDb(db).transaction((tx) =>
        replaceSettlementRefs(tx, created.id, [
          { source: "test-bank", externalId: label("ref") },
        ]),
      );
    return created;
  };

  it("reports only provisional accounts with no provider evidence", async () => {
    const empty = await account(ctx.db);
    const receiptOnly = await account(ctx.db);
    await transaction(ctx.db, receiptOnly.id);
    const statementBacked = await account(ctx.db);
    await transaction(ctx.db, statementBacked.id, { refs: true });
    const aliased = await account(ctx.db, {
      sourceAliases: [
        { source: "test-bank", alias: "Card", externalAccountId: "acct-1" },
      ],
    });
    const confirmed = await account(ctx.db, { provisional: false });
    const deletedEvidence = await account(ctx.db);
    await transaction(ctx.db, deletedEvidence.id, {
      refs: true,
      deleted: true,
    });
    const retired = await account(ctx.db);
    await getDb(ctx.db).execute(
      sql`UPDATE "FinancialAccount" SET "deletedAt" = now() WHERE "id" = ${retired.id}`,
    );

    const found = await findProvisionalFinancialAccounts(ctx.db);
    const byId = new Map(found.map((row) => [row.id, row]));

    expect([...byId.keys()].sort()).toEqual(
      [
        empty.shortcode,
        receiptOnly.shortcode,
        deletedEvidence.shortcode,
      ].sort(),
    );
    expect(byId.get(empty.shortcode)?.transactionCount).toBe(0);
    expect(byId.get(receiptOnly.shortcode)?.transactionCount).toBe(1);
    expect(byId.has(statementBacked.shortcode)).toBe(false);
    expect(byId.has(aliased.shortcode)).toBe(false);
    expect(byId.has(confirmed.shortcode)).toBe(false);
    expect(byId.has(retired.shortcode)).toBe(false);
  });
  it("exposes an unclaimed-account diagnostic without changing completeness weight", async () => {
    const unclaimed = await account(ctx.db);
    const claimed = await account(ctx.db, {
      sourceAliases: [
        {
          source: "synthetic-bank",
          alias: "Synthetic card",
          externalAccountId: "card-1",
        },
      ],
    });
    const quality = await loadDataQualities(ctx.db, "financialAccount", [
      unclaimed.id,
      claimed.id,
    ]);
    expect(quality.get(unclaimed.id)?.gaps.map((gap) => gap.check)).toContain(
      "financial_account_unclaimed",
    );
    expect(quality.get(claimed.id)?.gaps.map((gap) => gap.check)).not.toContain(
      "financial_account_unclaimed",
    );
    expect(quality.get(unclaimed.id)?.score).toBe(
      quality.get(claimed.id)?.score,
    );
  });
});
