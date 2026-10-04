import type { FinancialTransactionOut } from "@cubby/schemas/financial-transaction";
import {
  financialTransactionShortcode,
  runEntityId,
} from "@cubby/schemas/identifiers";
import { fromPartial } from "@total-typescript/shoehorn";
import { describe, expect, it, vi } from "vitest";

import { Database } from "~/server/db";

import type { JevPort } from "./jev";
import {
  type SettlementRank,
  suggestSettlementMatch,
} from "./settlement-candidate-rank";

// A Database that throws on any use: the op is read-only apart from usage
// accounting, which the injected Jev port bypasses entirely.
const db = new Database(() => {
  throw new Error("Settlement rank unit ports do not touch a database");
});
const usage = {
  db,
  runId: runEntityId.parse("00000000-0000-4000-8000-000000000001"),
  operation: "test-settlement-rank",
  cacheStatus: "none" as const,
};

const code = (suffix: string) =>
  financialTransactionShortcode.parse(`FTX-${suffix}`);
const rank = (
  suffix: string,
  exactAmount: boolean,
  merchantMatches: boolean,
): SettlementRank => ({
  transactionId: code(suffix),
  days: 1,
  exactAmount,
  merchantMatches,
});

const transaction = (id: string, amount: number) =>
  fromPartial<FinancialTransactionOut>({
    id,
    amount,
    kind: "purchase",
    merchant: "Example Hardware",
    displayName: "Example Hardware",
    accountName: "Example Card",
    postedDate: "2026-03-04",
    transactionDate: "2026-03-03",
  });

const subject = {
  vendorName: "Example Hardware",
  date: "2026-03-02",
  statedTotal: 42.5,
  orderId: "ORD-1001",
};

function jevFor(choice: string, probabilities: Record<string, number>) {
  const port: JevPort = vi.fn(async () => ({
    answers: {
      selection: {
        type: "choice" as const,
        choice,
        confidence: 0.9,
        probabilities,
      },
    },
  }));
  return port;
}

describe("suggestSettlementMatch", () => {
  it("does not call the model or open a run when nothing is tied", async () => {
    const jev = jevFor("c0", { c0: 0.9, none: 0.1 });
    const openUsage = vi.fn(async () => usage);
    const result = await suggestSettlementMatch({
      subject,
      ranks: [rank("4K7M", true, true), rank("5N8P", false, true)],
      loadTransaction: async (id) => transaction(id, 42.5),
      openUsage,
      jev,
    });
    expect(result).toEqual({
      status: "not_ambiguous",
      note: "These charges are no longer tied, so there is nothing to suggest.",
    });
    expect(jev).not.toHaveBeenCalled();
    expect(openUsage).not.toHaveBeenCalled();
  });

  it("shows the model only the tied candidates and returns the ranking", async () => {
    const jev = jevFor("c1", { c0: 0.2, c1: 0.7, none: 0.1 });
    const loaded: string[] = [];
    const result = await suggestSettlementMatch({
      subject,
      ranks: [
        rank("4K7M", true, true),
        rank("5N8P", true, true),
        rank("6Q9R", false, true),
      ],
      loadTransaction: async (id) => {
        loaded.push(id);
        return transaction(id, 42.5);
      },
      openUsage: async () => usage,
      jev,
    });
    expect(loaded).toEqual([code("4K7M"), code("5N8P")]);
    const input = vi.mocked(jev).mock.calls[0]?.[0];
    const criteria = input?.questions.selection.criteria ?? {};
    expect(Object.keys(criteria).sort()).toEqual(["c0", "c1", "none"]);
    expect(input?.state).toContain("ORD-1001");
    expect(input?.state).toContain("$42.50");
    expect(criteria.c0).toContain("$42.50");
    expect(criteria.c0).toContain("Example Card");
    expect(result).toEqual({
      status: "ranked",
      advisory: true,
      selectedTransactionId: code("5N8P"),
      ranked: [
        {
          transactionId: code("5N8P"),
          probability: 0.7,
          badge: "Suggested · 70%",
        },
        { transactionId: code("4K7M"), probability: 0.2, badge: "20%" },
      ],
      // Tied candidates by probability, then the rest in the server's order.
      displayOrder: [code("5N8P"), code("4K7M"), code("6Q9R")],
      note: "Suggestion only. Jev ordered the 2 equally ranked charges; nothing is saved until you allocate.",
    });
  });

  it("reports a none pick without selecting a candidate", async () => {
    const result = await suggestSettlementMatch({
      subject,
      ranks: [rank("4K7M", true, true), rank("5N8P", true, true)],
      loadTransaction: async (id) => transaction(id, 42.5),
      openUsage: async () => usage,
      jev: jevFor("none", { c0: 0.3, c1: 0.2, none: 0.5 }),
    });
    expect(result).toMatchObject({
      status: "ranked",
      selectedTransactionId: null,
      note: "Suggestion only. Jev ordered the 2 equally ranked charges; nothing is saved until you allocate. Jev found no clear match among them.",
    });
  });

  it("returns a structured unavailable result when the model fails", async () => {
    const jev: JevPort = vi.fn(async () => {
      throw new Error("Jev upstream returned 503: gateway timeout");
    });
    const result = await suggestSettlementMatch({
      subject,
      ranks: [rank("4K7M", true, true), rank("5N8P", true, true)],
      loadTransaction: async (id) => transaction(id, 42.5),
      openUsage: async () => usage,
      jev,
    });
    expect(result).toEqual({
      status: "unavailable",
      error: "Jev upstream returned 503: gateway timeout",
      note: "Suggestion unavailable: Jev upstream returned 503: gateway timeout",
    });
  });
});
