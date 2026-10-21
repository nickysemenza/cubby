import { statementTransactionJudgment } from "@cubby/schemas/statement-suggestion";
import { SEEDED_RULE_REVISIONS } from "tooling/factories/base-world";
import { describe, expect, it } from "vitest";

import { AUTOMATIC_RULES, matchFieldRules } from "./automatic-rules";

// A revision bump turns a rule off until a member re-enables it, so the seeded
// rows must name the revisions the code declares.
describe("seeded Automatic rule revisions", () => {
  it("match the declared rules in the test world", () => {
    for (const key of [
      "field.addition",
      "statement_transaction.attach",
    ] as const) {
      const revision = AUTOMATIC_RULES[key].revision();
      expect(SEEDED_RULE_REVISIONS[key]).toBe(revision);
    }
  });
});

// Failure mode: the automatic attach rule keeps its own copy of the clean
// predicate, so a candidate another charge already settles must stop it too.
describe("statement_transaction.attach", () => {
  const judgment = (claimed: boolean) =>
    statementTransactionJudgment.parse({
      recommended: "attach",
      accountId: "00000000-0000-4000-8000-000000000001",
      statementDate: "2026-05-05",
      providerStatus: "posted",
      create: {
        kind: "other",
        kindSource: "rule",
        status: "posted",
        amount: 4.5,
        transactionDate: null,
        postedDate: "2026-05-05",
        merchant: "Example Cafe",
        rawDescription: "EXAMPLE CAFE 0002",
        sourceCategory: null,
        notes: null,
        sourceRef: { source: "monarch", externalId: "synthetic-ref" },
      },
      candidates: [
        {
          transactionId: "00000000-0000-4000-8000-000000000002",
          amount: 4.5,
          status: "posted",
          postedDate: "2026-05-04",
          transactionDate: null,
          merchant: "Example Cafe",
          rawDescription: "EXAMPLE CAFE 0001",
          diff: ["postedDate"],
          label: { same: "same", confidence: "high", model: "synthetic" },
          claimed,
        },
      ],
      supersede: null,
      void: null,
      siblings: [],
      clean: false,
    });
  const rule = AUTOMATIC_RULES["statement_transaction.attach"];

  it("matches a free candidate and skips one another charge settles", () => {
    expect(rule.match(judgment(false))).toEqual({ model: "synthetic" });
    expect(rule.match(judgment(true))).toBeUndefined();
  });
  it("does not let a transaction-only legacy purchase attach authorize spending", () => {
    const legacy = judgment(false);
    legacy.create!.kind = "purchase";
    expect(rule.match(legacy)).toBeUndefined();
  });
});

// Failure modes: correcting a populated member field never matches, or broadening
// assignments silently admits pruning, undeclared fields, or review-required fields.
describe("field.addition", () => {
  const facts = {
    entity: "product" as const,
    field: "categoryId",
    kind: "addition",
    confidence: 0.97,
    model: "typesafe/jev",
  };

  // Failure: a confident correction overwrites a member value, or ordinary
  // additions remain gated on a Sweep model rather than current evidence.
  it("matches only additions at 95 percent without requiring a Sweep", () => {
    expect(matchFieldRules(facts)[0]?.key).toBe("field.addition");
    expect(matchFieldRules({ ...facts, kind: "correction" })).toEqual([]);
    expect(matchFieldRules({ ...facts, confidence: 0.949 })).toEqual([]);
    expect(matchFieldRules({ ...facts, confidence: 0.95 })[0]?.key).toBe(
      "field.addition",
    );
  });

  it("keeps review-required fields and pruning out of automatic assignments", () => {
    expect(
      matchFieldRules({ ...facts, entity: "expense", field: "lineKind" }),
    ).toEqual([]);
    expect(matchFieldRules({ ...facts, field: "tags" })).toEqual([]);
    expect(matchFieldRules({ ...facts, field: "undeclared" })).toEqual([]);
  });
});
