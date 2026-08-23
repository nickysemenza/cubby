import { describe, expect, it } from "vitest";
import {
  applyHouseholdLedgerChangesInput,
  previewHouseholdLedgerChangesInput,
  weightedBeneficiaries,
  weightedFunders,
} from "./household-contribution";

const person = (id: string) => ({ kind: "person" as const, id });
const fund = (key: string) => ({ kind: "fund" as const, key });

describe("household contribution contracts", () => {
  it("accepts exact-cent weights large enough for Splitwise amount vectors", () => {
    expect(
      weightedBeneficiaries.parse({
        people: [
          { personId: "PER-A234", weight: 120_300 },
          { personId: "PER-B234", weight: 39_365 },
        ],
      }),
    ).toEqual({
      people: [
        { personId: "PER-A234", weight: 120_300 },
        { personId: "PER-B234", weight: 39_365 },
      ],
    });
  });

  it("requires an explicit known or unattributed bucket", () => {
    expect(weightedBeneficiaries.safeParse({ people: [] }).success).toBe(false);
    expect(
      weightedBeneficiaries.safeParse({
        people: [],
        unattributedWeight: 1,
      }).success,
    ).toBe(true);
    expect(weightedFunders.safeParse({ parties: [] }).success).toBe(false);
  });

  it("rejects duplicate people and funding parties", () => {
    expect(
      weightedBeneficiaries.safeParse({
        people: [
          { personId: "PER-A234", weight: 1 },
          { personId: "PER-A234", weight: 2 },
        ],
      }).success,
    ).toBe(false);
    expect(
      weightedFunders.safeParse({
        parties: [
          { party: fund("household"), weight: 1 },
          { party: fund("household"), weight: 2 },
        ],
      }).success,
    ).toBe(false);
  });

  it("allows same-party endpoints only for internal account moves", () => {
    const base = {
      type: "put_funding_transfer" as const,
      amount: 50,
      date: "2026-08-23",
      sourceRefs: [],
      evidence: [],
    };
    expect(
      previewHouseholdLedgerChangesInput.safeParse({
        changes: [
          {
            ...base,
            from: fund("household"),
            to: fund("household"),
            kind: "internal_account_move",
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      previewHouseholdLedgerChangesInput.safeParse({
        changes: [
          {
            ...base,
            from: person("PER-A234"),
            to: person("PER-A234"),
            kind: "reimbursement",
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      previewHouseholdLedgerChangesInput.safeParse({
        changes: [
          {
            ...base,
            from: person("PER-A234"),
            to: person("PER-B234"),
            kind: "internal_account_move",
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("uses FTR shortcodes rather than raw UUIDs for transfer updates", () => {
    const base = {
      type: "put_funding_transfer" as const,
      from: person("PER-A234"),
      to: person("PER-B234"),
      kind: "reimbursement" as const,
      amount: 25,
      date: "2026-08-23",
      sourceRefs: [],
      evidence: [],
    };
    expect(
      previewHouseholdLedgerChangesInput.safeParse({
        changes: [{ ...base, transferId: "FTR-A234" }],
      }).success,
    ).toBe(true);
    expect(
      previewHouseholdLedgerChangesInput.safeParse({
        changes: [
          { ...base, transferId: "21e5e0dd-a310-43f0-9b06-ff9c041b73f9" },
        ],
      }).success,
    ).toBe(false);
  });

  it("distinguishes unchanged, clear, and whole-set replacement", () => {
    const unchanged = previewHouseholdLedgerChangesInput.parse({
      changes: [
        {
          type: "set_expense_attribution",
          expenseIds: ["EXP-A234"],
        },
      ],
    });
    expect(unchanged.changes[0]).not.toHaveProperty("beneficiaries");

    const cleared = previewHouseholdLedgerChangesInput.parse({
      changes: [
        {
          type: "set_expense_attribution",
          expenseIds: ["EXP-A234"],
          beneficiaries: null,
        },
      ],
    });
    expect(cleared.changes[0]).toHaveProperty("beneficiaries", null);
  });

  it("requires apply to carry the reviewed changes and idempotency key", () => {
    expect(
      applyHouseholdLedgerChangesInput.safeParse({
        previewFingerprint: "sha256:abc",
        idempotencyKey: "trip-import-v1",
        changes: [
          {
            type: "set_expense_attribution",
            expenseIds: ["EXP-A234"],
            funders: {
              parties: [{ party: fund("household"), weight: 1 }],
            },
          },
        ],
      }).success,
    ).toBe(true);
  });
});
