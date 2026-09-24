import { describe, expect, it } from "vitest";

import { parseMonarchCsv } from "./monarch-csv";

const header =
  "Date,Merchant,Category,Account,Original Statement,Notes,Amount,Tags,Owner,Reviewed,Id";

describe("Monarch CSV import normalization", () => {
  it("uses the same charge sign and source evidence for preview and durable rows", () => {
    const parsed = parseMonarchCsv(
      `${header}\n9/21/2026,Synthetic Outfitters,Clothing,Fixture Visa (...4242),SYNTHETIC OUTFITTERS ORDER 1,,-29.99,,Fixture Member,1,row-1`,
      "statement.csv",
      "fingerprint",
    );

    expect(parsed.preview.rows[0]).toMatchObject({
      key: "row-1",
      source: "monarch",
      date: "2026-09-21",
      amount: -29.99,
    });
    expect(parsed.record.rows[0]).toMatchObject({
      statementDate: "2026-09-21",
      providerAmount: -29.99,
      rawDescription: "SYNTHETIC OUTFITTERS ORDER 1",
    });
    expect(parsed.record.import).toMatchObject({
      source: "monarch",
      fingerprint: "fingerprint",
      rowCountDeclared: 1,
    });
  });

  it("rejects a zero amount before a source identity can be minted", () => {
    expect(() =>
      parseMonarchCsv(
        `${header}\n2026-09-21,Synthetic Outfitters,Clothing,Fixture Visa,ORDER 1,,0.00,,,,row-1`,
        "statement.csv",
        "fingerprint",
      ),
    ).toThrow("Invalid Monarch amount");
  });
});
