import type { DescriptorProcessor } from "@cubby/schemas/financial-transaction-fields";
import { createRepoEntity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

import { listFinancialTransactions } from "./financial-transaction";

// The processor filter derives from the raw descriptor in SQL; it must agree
// with `parseBankDescriptor`, which reads the same patterns.
describe("financial transaction descriptor processor filter", () => {
  const ctx = withTestDb();

  it("selects charges by the processor named in their descriptor", async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic descriptor member",
      kind: "member",
    });
    const card = await createRepoEntity(ctx, "financialAccount", {
      name: "Synthetic descriptor card",
      identity: { kind: "cash" },
      ledgerPartyId: party.shortcode,
      provisional: false,
    });
    const charges = new Map<string, string>();
    for (const [index, rawDescription] of [
      "TST* SYNTHETIC DINER #42",
      "tst*synthetic cafe",
      "\tTST*\tSYNTHETIC GRILL",
      "SQ  *SYNTHETIC MARKET",
      // A non-ASCII space is not a processor separator in either engine.
      "SP\u00A0SYNTHETIC GOODS",
      "SYNTHETIC HARDWARE",
    ].entries()) {
      const created = await createRepoEntity(ctx, "financialTransaction", {
        accountId: card.output.id,
        kind: "purchase",
        amount: 10 + index,
        status: "posted",
        transactionDate: "2026-09-01",
        postedDate: "2026-09-02",
        merchant: null,
        rawDescription,
        sourceRefs: [
          {
            source: "synthetic-bank",
            externalId: `synthetic-descriptor-${index}`,
          },
        ],
        allocations: [],
      });
      charges.set(created.output.id, rawDescription);
    }
    const listed = async (descriptorProcessor: DescriptorProcessor[]) =>
      (
        await listFinancialTransactions(ctx.db, { descriptorProcessor }, [], {
          pageIndex: 0,
          pageSize: 50,
        })
      ).data
        .map((row) => charges.get(row.id))
        .sort();

    expect(await listed(["toast"])).toEqual(
      [
        "TST* SYNTHETIC DINER #42",
        "tst*synthetic cafe",
        "\tTST*\tSYNTHETIC GRILL",
      ].sort(),
    );
    expect(await listed(["square", "toast"])).toHaveLength(4);
    expect(await listed(["shopify"])).toEqual([]);
  });
});
