import { shortcode } from "@cubby/schemas/identifiers";
import {
  statementSuggestionOut,
  type StatementSuggestionOut,
} from "@cubby/schemas/statement-suggestion";
import { describe, expect, it } from "vitest";

import {
  statementApplyItem as applyItem,
  statementDismissItem as dismissItem,
} from "./suggestion-review";

const FTX_A = shortcode("FTX-2A2A");
const FTX_B = shortcode("FTX-3B3B");

const candidate = (transactionId: typeof FTX_A) => ({
  transactionId,
  amount: 42.5,
  status: "pending" as const,
  postedDate: null,
  transactionDate: "2026-05-03",
  merchant: "Example Grocer",
  rawDescription: "EXAMPLE GROCER",
  diff: ["postedDate" as const, "status" as const],
  label: null,
});

const suggestion = (
  overrides: Partial<StatementSuggestionOut> = {},
): StatementSuggestionOut =>
  statementSuggestionOut.parse({
    assessmentId: "00000000-0000-4000-8000-000000000001",
    fingerprint: "fp-1",
    source: "monarch",
    chargeKey: "charge-1",
    accountId: "FAC-4C4C",
    ownerId: null,
    statementDate: "2026-05-04",
    amount: 42.5,
    merchant: "Example Grocer",
    rawDescription: "EXAMPLE GROCER 0001",
    sourceCategory: "Groceries",
    providerStatus: "posted",
    recommended: "attach",
    clean: false,
    create: {
      kind: "purchase",
      kindSource: "rule",
      status: "posted",
      amount: 42.5,
      transactionDate: null,
      postedDate: "2026-05-04",
      merchant: "Example Grocer",
      rawDescription: "EXAMPLE GROCER 0001",
      sourceCategory: "Groceries",
      notes: null,
    },
    candidates: [candidate(FTX_A), candidate(FTX_B)],
    supersedeTransactionId: null,
    voidTransactionId: null,
    siblings: 0,
    model: null,
    createdAt: "2026-05-05T00:00:00.000Z",
    ...overrides,
  });

describe("statement suggestion review items", () => {
  it("accepts the recommendation as Correct without a correction", () => {
    const item = applyItem(suggestion());
    expect(item).toMatchObject({
      verdict: "correct",
      correction: { present: false },
      intent: "apply",
      expectedFingerprint: "fp-1",
      application: {
        action: "attach",
        fields: [],
        rejectedCandidateIds: [],
      },
    });
  });

  it("an attach names its target even with a single candidate", () => {
    const item = applyItem(suggestion({ candidates: [candidate(FTX_A)] }));
    expect(item.verdict).toBe("correct");
    expect(item.application).toMatchObject({ transactionId: FTX_A });
  });

  it("reviews another candidate or ticked fields as Wrong with the same application", () => {
    const item = applyItem(suggestion(), {
      action: "attach",
      transactionId: FTX_B,
      fields: ["status"],
    });
    expect(item.verdict).toBe("wrong");
    expect(item.application).toMatchObject({
      transactionId: FTX_B,
      fields: ["status"],
    });
    expect(item.correction).toEqual({
      present: true,
      value: item.application,
    });
  });

  it("create anyway rejects every candidate, which the server requires", () => {
    const item = applyItem(suggestion(), {
      action: "create",
      kindOverride: "refund",
    });
    expect(item.verdict).toBe("wrong");
    expect(item.application).toMatchObject({
      action: "create",
      kindOverride: "refund",
      rejectedCandidateIds: [FTX_A, FTX_B],
    });
  });

  it("an unchanged kind is not an override", () => {
    const item = applyItem(
      suggestion({ recommended: "create", candidates: [] }),
      { action: "create", kindOverride: "purchase" },
    );
    expect(item.verdict).toBe("correct");
    expect(item.application).not.toHaveProperty("kindOverride");
  });

  it("dismisses into history with the charge's suppression key", () => {
    expect(dismissItem(suggestion())).toMatchObject({
      verdict: "dismissed",
      intent: "history",
      correction: { present: false },
      suppression: {
        scope: "statement_transaction",
        candidateKey: "monarch:charge-1",
        fingerprint: "fp-1",
      },
    });
  });
});
