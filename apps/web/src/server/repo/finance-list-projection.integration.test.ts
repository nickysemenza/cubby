import { countTestDbQueries, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { listReadFields } from "~/entities/list-read-schema";
import { createTestRequestContext } from "~/server/testing/request-context";

import {
  listFinancialAccounts,
  listFinancialAccountsRead,
} from "./financial-account";
import {
  listFinancialTransactions,
  listFinancialTransactionsRead,
} from "./financial-transaction";
import {
  ledgerTransferRepository,
  listLedgerTransfersRead,
} from "./ledger-transfer";
import { type ListEnrichmentGroup } from "./list-projection";
import { purchaseList, purchaseListRead } from "./purchase";
import { insertWithShortcode } from "./shortcode-utils";
import { vendorList, vendorListRead } from "./vendor";
import { wishList, wishListRead } from "./wish";

// Core queries must avoid unrequested aggregates, reference payloads, quality,
// images, and whole-filter sums. Group patches must reproduce full reads.
describe("finance list projections", () => {
  const ctx = withTestDb();
  it("loads canonical core and requested patches without the full-read work", async () => {
    const owner = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic projection owner",
      kind: "member",
    });
    const target = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic projection target",
      kind: "household",
    });
    const supplier = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic projection supplier",
    });
    const account = await insertWithShortcode(ctx.db, "financialAccount", {
      name: "Synthetic projection account",
      identity: { kind: "cash" },
      ledgerPartyId: owner.id,
    });
    const transfer = await insertWithShortcode(ctx.db, "ledgerTransfer", {
      fromPartyId: owner.id,
      toPartyId: target.id,
      amount: 12,
      date: "2026-01-02",
    });
    await insertWithShortcode(ctx.db, "financialTransaction", {
      accountId: account.id,
      ledgerTransferId: transfer.id,
      amount: 12,
      kind: "account_transfer",
      status: "posted",
      postedDate: "2026-01-02",
      merchant: "Synthetic projection merchant",
    });
    await insertWithShortcode(ctx.db, "purchase", {
      vendorId: supplier.id,
      orderId: "SYNTHETIC-PROJECTION",
      date: "2026-01-02",
      statedTotal: 999,
    });
    await insertWithShortcode(ctx.db, "wish", {
      name: "Synthetic projection wish",
    });
    const page = { pageIndex: 0, pageSize: 25 };
    const cases = [
      {
        entity: "financialAccount",
        full: () => listFinancialAccounts(ctx.db, {}, [], page),
        read: (groups?: ListEnrichmentGroup[]) =>
          listFinancialAccountsRead(
            ctx.db,
            {},
            [],
            page,
            groups ? { kind: "enrichment", groups } : { kind: "base" },
          ),
        forbidden: [
          "FinancialTransaction",
          "SELECT shortcode",
          "DataQuality",
          "Image",
        ],
      },
      {
        entity: "financialTransaction",
        full: () => listFinancialTransactions(ctx.db, {}, [], page),
        read: (groups?: ListEnrichmentGroup[]) =>
          listFinancialTransactionsRead(
            ctx.db,
            {},
            [],
            page,
            "page",
            groups ? { kind: "enrichment", groups } : { kind: "base" },
          ),
        forbidden: [
          "FinancialTransactionAllocation",
          "LedgerTransfer",
          "DataQuality",
          "Image",
          "SettlementRef",
        ],
      },
      {
        entity: "ledgerTransfer",
        full: () =>
          ledgerTransferRepository.repository.list(
            { ...createTestRequestContext(ctx.db), actorContext: ctx.actor },
            {},
            [],
            page,
          ),
        read: (groups?: ListEnrichmentGroup[]) =>
          listLedgerTransfersRead(
            ctx.db,
            {},
            [],
            page,
            groups ? { kind: "enrichment", groups } : { kind: "base" },
          ),
        forbidden: [
          "LedgerSourceClaim",
          "FinancialTransaction",
          "DataQuality",
          "Image",
        ],
      },
      {
        entity: "vendor",
        full: () => vendorList(ctx.db, {}, [], page),
        read: (groups?: ListEnrichmentGroup[]) =>
          vendorListRead(
            ctx.db,
            {},
            [],
            page,
            "page",
            groups ? { kind: "enrichment", groups } : { kind: "base" },
          ),
        forbidden: [
          "Purchase",
          "Expense",
          "DataQuality",
          "Image",
          "EntityAttachment",
        ],
      },
      {
        entity: "purchase",
        full: () => purchaseList(ctx.db, {}, [], page),
        read: (groups?: ListEnrichmentGroup[]) =>
          purchaseListRead(
            ctx.db,
            {},
            [],
            page,
            "page",
            groups ? { kind: "enrichment", groups } : { kind: "base" },
          ),
        forbidden: [
          "FinancialTransaction",
          "Expense",
          "DataQuality",
          "Image",
          "EntityAttachment",
        ],
      },
      {
        entity: "wish",
        full: () => wishList(ctx.db, {}, [], page),
        read: (groups?: ListEnrichmentGroup[]) =>
          wishListRead(
            ctx.db,
            {},
            [],
            page,
            groups ? { kind: "enrichment", groups } : { kind: "base" },
          ),
        forbidden: ["Product", "EntityLink", "DataQuality", "Image"],
      },
    ] as const;
    for (const entry of cases) {
      const full = await entry.full();
      const core = await countTestDbQueries(() => entry.read());
      expect(core.queryCount).toBe(2);
      expect(core.result.count).toBe(full.count);
      expect(core.result).not.toHaveProperty("sums");
      expect(core.result.data).toHaveLength(1);
      const statements = core.statements.join("\n");
      for (const forbidden of entry.forbidden)
        expect(statements).not.toContain(`"${forbidden}"`);
      const merged = { ...core.result.data[0] };
      for (const group of [
        "relations",
        "derived",
        "quality",
        "media",
      ] as const) {
        if (listReadFields(entry.entity)[group].length === 0) continue;
        const patch = await entry.read([group]);
        expect(Object.keys(patch.data[0] ?? {})).toEqual(
          expect.arrayContaining(["id"]),
        );
        Object.assign(merged, patch.data[0]);
      }
      expect(merged).toEqual(full.data[0]);
    }
  });
});
