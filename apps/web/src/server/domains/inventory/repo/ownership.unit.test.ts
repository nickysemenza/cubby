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
    ).toMatchObject({
      status: "owner",
      ownerId: "person-a",
      reason: "beneficiary_agreement",
    });
  });

  it.each([
    {
      name: "one applicable line is missing attribution",
      reason: "beneficiary_incomplete",
      rows: [{ expenseShortcode: "EXP-1", ledgerPartyId: "person-a" }],
    },
    {
      name: "a line is split",
      reason: "beneficiary_split",
      rows: [
        { expenseShortcode: "EXP-1", ledgerPartyId: "person-a" },
        { expenseShortcode: "EXP-1", ledgerPartyId: "person-b" },
        { expenseShortcode: "EXP-2", ledgerPartyId: "person-a" },
      ],
    },
    {
      name: "lines conflict",
      reason: "beneficiary_conflict",
      rows: [
        { expenseShortcode: "EXP-1", ledgerPartyId: "person-a" },
        { expenseShortcode: "EXP-2", ledgerPartyId: "person-b" },
      ],
    },
    {
      name: "a beneficiary is unresolved",
      reason: "beneficiary_unresolved",
      rows: [
        { expenseShortcode: "EXP-1", ledgerPartyId: null },
        { expenseShortcode: "EXP-2", ledgerPartyId: "person-a" },
      ],
    },
    {
      name: "the household is the named beneficiary",
      reason: "beneficiary_not_individual",
      rows: [
        { expenseShortcode: "EXP-1", ledgerPartyId: "household" },
        { expenseShortcode: "EXP-2", ledgerPartyId: "household" },
      ],
    },
  ])("blocks weaker fallback when $name", ({ rows, reason }) => {
    expect(
      resolveBeneficiaryEvidence({
        applicableExpenseIds: ["EXP-1", "EXP-2"],
        rows,
        isIndividual,
      }),
    ).toMatchObject({ status: "blocked", ownerId: null, reason });
  });

  it("allows account fallback for absent or entirely unknown beneficiaries", () => {
    expect(
      resolveBeneficiaryEvidence({
        applicableExpenseIds: ["EXP-1"],
        rows: [],
        isIndividual,
      }),
    ).toMatchObject({
      status: "none",
      ownerId: null,
      reason: "beneficiary_absent",
    });
    expect(
      resolveBeneficiaryEvidence({
        applicableExpenseIds: ["EXP-1", "EXP-2"],
        rows: [
          { expenseShortcode: "EXP-1", ledgerPartyId: null },
          { expenseShortcode: "EXP-2", ledgerPartyId: null },
        ],
        isIndividual,
      }),
    ).toMatchObject({
      status: "none",
      ownerId: null,
      reason: "beneficiary_unknown",
    });
    expect(
      resolveBeneficiaryEvidence({
        applicableExpenseIds: ["EXP-1"],
        rows: [{ expenseShortcode: "EXP-1", ledgerPartyId: "shared-party" }],
        isIndividual,
      }),
    ).toMatchObject({
      status: "blocked",
      ownerId: null,
      reason: "beneficiary_not_individual",
    });
    expect(resolvePaymentEvidence({ rows: [], isIndividual })).toMatchObject({
      ownerId: null,
      reason: "payment_absent",
    });
    expect(
      resolvePaymentEvidence({
        rows: [{ enabled: true, ledgerPartyId: null }],
        isIndividual,
      }),
    ).toMatchObject({ ownerId: null, reason: "payment_unresolved" });
    expect(
      resolvePaymentEvidence({
        rows: [{ enabled: true, ledgerPartyId: "shared-party" }],
        isIndividual,
      }),
    ).toMatchObject({ ownerId: null, reason: "payment_not_individual" });
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
    ).toMatchObject({ ownerId: "person-a", reason: "payment_agreement" });

    expect(
      resolvePaymentEvidence({
        rows: [
          { enabled: true, ledgerPartyId: "person-a" },
          { enabled: false, ledgerPartyId: "person-b" },
        ],
        isIndividual,
      }),
    ).toMatchObject({ ownerId: null, reason: "payment_disabled" });

    expect(
      resolvePaymentEvidence({
        rows: [
          { enabled: true, ledgerPartyId: "person-a" },
          { enabled: true, ledgerPartyId: "person-b" },
        ],
        isIndividual,
      }),
    ).toMatchObject({ ownerId: null, reason: "payment_conflict" });
  });
});
