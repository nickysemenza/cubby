import { describe, expect, it } from "vitest";
import { statementRowExternalId } from "./statement-row-identity";

/**
 * Rows whose refs are already stored on live FinancialTransactions, captured
 * from a `preview_financial_statement_import` run that returned
 * `already_recorded` for each. They are here so the identity function is pinned
 * to production data rather than to itself: 2,756 stored `v1:` refs are only
 * findable while these reproduce byte-for-byte.
 */
const STORED = [
  {
    row: {
      source: "monarch",
      account: "Blue Cash Preferred® (...1005)",
      date: "2024-08-29",
      amount: -959.78,
      originalStatement: "MOORE NEWTON QUALITYSAN LEANDRO CA",
    },
    externalId:
      "v1:8d91a684e45c90bd6ecee1ffaddd7e147c30063416ea5c16f6421aa316f6e168",
  },
  {
    row: {
      source: "monarch",
      account: "Blue Cash Preferred® (...1005)",
      date: "2024-06-09",
      amount: -100,
      originalStatement: "DASHBOARD PWS BOULDER CO",
    },
    externalId:
      "v1:ca417d6129884407cbdb09a306b4b3a42c39718c0ba44ef39d00b4299f504daf",
  },
] as const;

describe("statementRowExternalId", () => {
  it.each(STORED)(
    "reproduces the stored ref for $row.originalStatement",
    async ({ row, externalId }) => {
      await expect(statementRowExternalId(row)).resolves.toBe(externalId);
    },
  );

  it("namespaces by source, so two providers describing one charge stay two rows", async () => {
    const [{ row, externalId }] = STORED;
    await expect(
      statementRowExternalId({ ...row, source: "copilot" }),
    ).resolves.not.toBe(externalId);
  });

  it.each([
    ["case", { account: "BLUE CASH PREFERRED® (...1005)" }],
    [
      "repeated whitespace",
      { originalStatement: "DASHBOARD  PWS  BOULDER CO" },
    ],
    [
      "surrounding whitespace",
      { originalStatement: " DASHBOARD PWS BOULDER CO " },
    ],
    ["trailing-zero cents", { amount: -100.0 }],
  ] as const)("ignores %s", async (_label, patch) => {
    const [, fixture] = STORED;
    await expect(
      statementRowExternalId({ ...fixture.row, ...patch }),
    ).resolves.toBe(fixture.externalId);
  });
});
