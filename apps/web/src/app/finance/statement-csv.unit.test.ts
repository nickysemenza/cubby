import { describe, expect, it } from "vitest";

import {
  parseMappedStatementCsv,
  parseStatementCsv,
  previewStatementBatch,
  recordStatementBatch,
} from "./statement-csv";

const monarchHeader =
  "Date,Merchant,Category,Account,Original Statement,Notes,Amount,Tags,Owner,Reviewed,Id";

describe("statement CSV normalization", () => {
  it("keeps Monarch preview and durable source evidence aligned", () => {
    const parsed = parseStatementCsv(
      `${monarchHeader}\n9/21/2026,Synthetic Outfitters,Clothing,Fixture Visa (...4242),SYNTHETIC ORDER 1,,-29.99,,Fixture Member,1,row-1`,
      "statement.csv",
      "fingerprint",
    );
    expect(previewStatementBatch(parsed)?.rows[0]).toMatchObject({
      source: "monarch",
      date: "2026-09-21",
      amount: -29.99,
    });
    expect(recordStatementBatch(parsed).rows[0]).toMatchObject({
      statementDate: "2026-09-21",
      providerAmount: -29.99,
      rawDescription: "SYNTHETIC ORDER 1",
    });
  });

  it("uses Mint debit and credit type rather than unsigned amount", () => {
    const header =
      "Date,Description,Original Description,Amount,Transaction Type,Category,Account Name,Labels,Notes";
    const parsed = parseStatementCsv(
      `${header}\n9/21/2026,Synthetic Shop,SHOP ORDER,29.99,debit,Clothing,Fixture Visa,,\n9/22/2026,Synthetic Shop,SHOP REFUND,5.00,credit,Clothing,Fixture Visa,,`,
      "mint.csv",
      "mint-fp",
    );
    expect(parsed.recordRows.map((row) => row.providerAmount)).toEqual([
      -29.99, 5,
    ]);
  });

  it("flips Copilot charges, retains pending evidence, and excludes pending from transaction preview", () => {
    const header =
      "date,name,amount,status,category,parent category,excluded,tags,type,account,account mask,note,recurring";
    const parsed = parseStatementCsv(
      `${header}\n2026-09-21,Synthetic Shop,29.99,posted,Clothing,,, ,regular,Fixture Visa,4242,,\n2026-09-22,Synthetic Shop,5.00,pending,Clothing,,, ,regular,Fixture Visa,4242,,`,
      "copilot.csv",
      "copilot-fp",
    );
    expect(parsed.recordRows.map((row) => row.providerAmount)).toEqual([
      -29.99, -5,
    ]);
    expect(parsed.pending).toBe(1);
    expect(previewStatementBatch(parsed)?.rows).toHaveLength(1);
  });

  it("allows a pending-only export to save evidence without a transaction preview", () => {
    const parsed = parseStatementCsv(
      "date,name,amount,status,category,type,account,account mask,note\n2026-09-21,Synthetic Shop,9.00,pending,Clothing,regular,Fixture Visa,4242,",
      "pending.csv",
      "pending-fp",
    );
    expect(previewStatementBatch(parsed)).toBeNull();
    expect(recordStatementBatch(parsed).rows[0]?.providerStatus).toBe(
      "pending",
    );
  });

  it("normalizes Apple Card charge-positive amounts and uses transaction date", () => {
    const header =
      "Transaction Date,Clearing Date,Description,Merchant,Category,Type,Amount (USD)";
    const parsed = parseStatementCsv(
      `${header}\n09/21/2026,09/22/2026,SYNTHETIC ORDER,Synthetic Shop,Shopping,Purchase,29.99`,
      "apple.csv",
      "apple-fp",
    );
    expect(parsed.source).toBe("apple-card");
    expect(parsed.dateKind).toBe("transaction");
    expect(parsed.recordRows[0]?.providerAmount).toBe(-29.99);
  });

  it("maps an unfamiliar CSV only with an explicit source, account, and sign rule", () => {
    const parsed = parseMappedStatementCsv(
      "When,Details,Total,Flow\n2026-09-21,Synthetic purchase,29.99,out\n2026-09-22,Synthetic refund,5.00,in",
      "custom.csv",
      "custom-fp",
      {
        source: "fixture-export",
        account: "Fixture checking (...4242)",
        accountColumn: "",
        date: "When",
        amount: "Total",
        description: "Details",
        merchant: "",
        category: "",
        notes: "",
        direction: "Flow",
        status: "",
        pendingValue: "pending",
        chargeValue: "out",
        creditValue: "in",
        sign: "direction-column",
      },
    );
    expect(parsed.recordRows.map((row) => row.providerAmount)).toEqual([
      -29.99, 5,
    ]);
    expect(parsed.source).toBe("fixture-export");
  });

  it("takes accounts per row and preserves pending status from an unfamiliar CSV", () => {
    const parsed = parseMappedStatementCsv(
      "When,Details,Total,Account,Status\n2026-09-21,Synthetic purchase,29.99,Fixture Visa,posted\n2026-09-22,Synthetic hold,5.00,Fixture checking,pending",
      "multi-account.csv",
      "multi-fp",
      {
        source: "fixture-export",
        account: "",
        accountColumn: "Account",
        date: "When",
        amount: "Total",
        description: "Details",
        merchant: "",
        category: "",
        notes: "",
        direction: "",
        status: "Status",
        pendingValue: "pending",
        chargeValue: "debit",
        creditValue: "credit",
        sign: "charges-positive",
      },
    );
    expect(parsed.recordRows.map((row) => row.accountDescriptor)).toEqual([
      "Fixture Visa",
      "Fixture checking",
    ]);
    expect(parsed.pending).toBe(1);
    expect(previewStatementBatch(parsed)?.rows).toHaveLength(1);
  });

  it("splits a full-size export into stable record and preview chunks", () => {
    const csv = `${monarchHeader}\n${Array.from(
      { length: 1101 },
      (_, index) =>
        `9/21/2026,Synthetic Shop,Clothing,Fixture Visa,ORDER ${index + 1},,-1.00,,,,row-${index + 1}`,
    ).join("\n")}`;
    const parsed = parseStatementCsv(csv, "large.csv", "large-fp");
    expect(previewStatementBatch(parsed)?.rows).toHaveLength(200);
    expect(recordStatementBatch(parsed).rows).toHaveLength(500);
    expect(recordStatementBatch(parsed, 500).rows).toHaveLength(500);
    expect(recordStatementBatch(parsed, 1000).rows).toHaveLength(101);
    expect(recordStatementBatch(parsed, 1000).import.fingerprint).toBe(
      "large-fp",
    );
  });

  it("rejects invalid dates and accounts for zero-value rows without minting identities", () => {
    expect(() =>
      parseStatementCsv(
        `${monarchHeader}\n9/31/2026,Synthetic Shop,Clothing,Fixture Visa,ORDER 1,,-1.00,,,,row-1`,
        "bad-date.csv",
        "date-fp",
      ),
    ).toThrow("Invalid statement date");
    const parsed = parseStatementCsv(
      `${monarchHeader}\n9/21/2026,Synthetic Shop,Clothing,Fixture Visa,ORDER 1,,0.00,,,,row-1\n9/22/2026,Synthetic Shop,Clothing,Fixture Visa,ORDER 2,,-3.00,,,,row-2`,
      "zero-amount.csv",
      "amount-fp",
    );
    expect(parsed.zeroValueRows).toBe(1);
    expect(recordStatementBatch(parsed).rows).toHaveLength(1);
  });
});
