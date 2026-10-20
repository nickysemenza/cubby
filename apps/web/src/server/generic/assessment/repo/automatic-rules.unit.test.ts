import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { statementTransactionJudgment } from "@cubby/schemas/statement-suggestion";
import { SEEDED_RULE_REVISIONS } from "tooling/factories/base-world";
import { describe, expect, it } from "vitest";

import { AUTOMATIC_RULES } from "./automatic-rules";

const migration = readFileSync(
  fileURLToPath(
    new URL(
      "../../../../../drizzle/0091_sweeps_maintenance_automatic_rules.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);

// A revision bump turns a rule off until a member re-enables it, so the seeded
// rows must name the revisions the code declares.
describe("seeded Automatic rule revisions", () => {
  it("match the declared rules in the migration and the test world", () => {
    expect(Object.keys(SEEDED_RULE_REVISIONS).sort()).toEqual(
      Object.keys(AUTOMATIC_RULES).sort(),
    );
    for (const key of [
      "field.addition",
      "statement_transaction.attach",
    ] as const) {
      const revision = AUTOMATIC_RULES[key].revision();
      expect(SEEDED_RULE_REVISIONS[key]).toBe(revision);
      expect(migration).toContain(`'${key}', '${revision}'`);
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
        kind: "purchase",
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
});
