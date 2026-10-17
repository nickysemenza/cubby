import type { FinancialTransactionOut } from "@cubby/schemas/financial-transaction";
import {
  financialTransactionShortcode,
  runEntityId,
} from "@cubby/schemas/identifiers";
import { fromPartial } from "@total-typescript/shoehorn";
import { describe, expect, it, vi } from "vitest";

import { createDatabase } from "~/server/db/database-runtime";

import type { DecisionPort } from "./decision-model";
import {
  type SettlementRank,
  suggestSettlementMatch,
} from "./settlement-candidate-rank";

// A Database that throws on any use: the op is read-only apart from usage
// accounting, which the injected decision port bypasses entirely.
const db = createDatabase(() => {
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
  conflicts: [],
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

function decisionPortFor(
  choice: string,
  probabilities: Record<string, number>,
) {
  const port: DecisionPort = vi.fn(async () => ({
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
  it("does not call the model or open a run when fewer than two candidates exist", async () => {
    const decisionPort = decisionPortFor("c0", { c0: 0.9, none: 0.1 });
    const openUsage = vi.fn(async () => usage);
    const result = await suggestSettlementMatch({
      subject,
      ranks: [rank("4K7M", true, true)],
      loadTransaction: async (id) => transaction(id, 42.5),
      openUsage,
      decisionPort,
    });
    expect(result).toEqual({
      status: "not_ambiguous",
      note: "Fewer than two candidates remain; a sole candidate still requires evidence review.",
    });
    expect(decisionPort).not.toHaveBeenCalled();
    expect(openUsage).not.toHaveBeenCalled();
  });

  it("lets the declared model rank differently named and differently sized alternatives", async () => {
    const decisionPort = decisionPortFor("c2", {
      c0: 0.1,
      c1: 0.1,
      c2: 0.7,
      none: 0.1,
    });
    const loaded: string[] = [];
    const result = await suggestSettlementMatch({
      subject,
      ranks: [
        rank("4K7M", true, true),
        rank("5N8P", true, true),
        rank("6Q9R", false, false),
      ],
      loadTransaction: async (id) => {
        loaded.push(id);
        return transaction(id, 42.5);
      },
      openUsage: async () => usage,
      decisionPort,
    });
    expect(loaded).toEqual([code("4K7M"), code("5N8P"), code("6Q9R")]);
    const input = vi.mocked(decisionPort).mock.calls[0]?.[0];
    const criteria = input?.questions.selection.criteria ?? {};
    expect(Object.keys(criteria).sort()).toEqual(["c0", "c1", "c2", "none"]);
    expect(input?.state).toContain("ORD-1001");
    expect(input?.state).toContain("$42.50");
    expect(criteria.c0).toContain("$42.50");
    expect(criteria.c0).toContain("Example Card");
    expect(result).toMatchObject({
      status: "ranked",
      advisory: true,
      selectedTransactionId: code("6Q9R"),
      displayOrder: [code("6Q9R"), code("4K7M"), code("5N8P")],
    });
  });

  it("reports a none pick without selecting a candidate", async () => {
    const result = await suggestSettlementMatch({
      subject,
      ranks: [rank("4K7M", true, true), rank("5N8P", true, true)],
      loadTransaction: async (id) => transaction(id, 42.5),
      openUsage: async () => usage,
      decisionPort: decisionPortFor("none", { c0: 0.3, c1: 0.2, none: 0.5 }),
    });
    expect(result).toMatchObject({
      status: "ranked",
      selectedTransactionId: null,
      note: "Suggestion only. The decision model ordered 2 candidate transactions; nothing is saved until you allocate. The decision model found no clear match among them.",
    });
  });

  it("returns a structured unavailable result when the model fails", async () => {
    const decisionPort: DecisionPort = vi.fn(async () => {
      throw new Error("decision upstream returned 503: gateway timeout");
    });
    const result = await suggestSettlementMatch({
      subject,
      ranks: [rank("4K7M", true, true), rank("5N8P", true, true)],
      loadTransaction: async (id) => transaction(id, 42.5),
      openUsage: async () => usage,
      decisionPort,
    });
    expect(result).toEqual({
      status: "unavailable",
      error: "decision upstream returned 503: gateway timeout",
      note: "Suggestion unavailable: decision upstream returned 503: gateway timeout",
    });
  });
});
