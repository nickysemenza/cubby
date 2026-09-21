import { describe, expect, it } from "vitest";

import {
  resolveBeneficiaryEvidence,
  resolvePaymentEvidence,
} from "./ownership-evidence";

describe("inventory ownership evidence", () => {
  const individuals = new Set(["person-a", "person-b"]);
  const isIndividual = (id: string) => individuals.has(id);

  it("accepts repeated acquisition lines when each wholly names the same person", () => {
    expect(
      resolveBeneficiaryEvidence({
        applicableExpenseIds: ["EXP-1", "EXP-2"],
        rows: [
          { expenseShortcode: "EXP-1", ledgerPartyId: "person-a" },
          { expenseShortcode: "EXP-2", ledgerPartyId: "person-a" },
        ],
        isIndividual,
      }),
    ).toEqual({ status: "owner", ownerId: "person-a" });
  });

  it.each([
    {
      name: "one applicable line is missing attribution",
      rows: [{ expenseShortcode: "EXP-1", ledgerPartyId: "person-a" }],
    },
    {
      name: "a line is split",
      rows: [
        { expenseShortcode: "EXP-1", ledgerPartyId: "person-a" },
        { expenseShortcode: "EXP-1", ledgerPartyId: "person-b" },
        { expenseShortcode: "EXP-2", ledgerPartyId: "person-a" },
      ],
    },
    {
      name: "lines conflict",
      rows: [
        { expenseShortcode: "EXP-1", ledgerPartyId: "person-a" },
        { expenseShortcode: "EXP-2", ledgerPartyId: "person-b" },
      ],
    },
    {
      name: "a beneficiary is shared or household",
      rows: [
        { expenseShortcode: "EXP-1", ledgerPartyId: null },
        { expenseShortcode: "EXP-2", ledgerPartyId: "person-a" },
      ],
    },
  ])("blocks weaker fallback when $name", ({ rows }) => {
    expect(
      resolveBeneficiaryEvidence({
        applicableExpenseIds: ["EXP-1", "EXP-2"],
        rows,
        isIndividual,
      }),
    ).toEqual({ status: "blocked", ownerId: null });
  });

  it("uses payment ownership only when every qualifying payment agrees", () => {
    expect(
      resolvePaymentEvidence({
        rows: [
          { enabled: true, ledgerPartyId: "person-a" },
          { enabled: true, ledgerPartyId: "person-a" },
        ],
        isIndividual,
      }),
    ).toBe("person-a");

    expect(
      resolvePaymentEvidence({
        rows: [
          { enabled: true, ledgerPartyId: "person-a" },
          { enabled: false, ledgerPartyId: "person-b" },
        ],
        isIndividual,
      }),
    ).toBeNull();

    expect(
      resolvePaymentEvidence({
        rows: [
          { enabled: true, ledgerPartyId: "person-a" },
          { enabled: true, ledgerPartyId: "person-b" },
        ],
        isIndividual,
      }),
    ).toBeNull();
  });
});
