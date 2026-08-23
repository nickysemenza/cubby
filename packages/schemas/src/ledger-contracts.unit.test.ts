import { describe, expect, it } from "vitest";
import { financialTransactionCreateInput } from "./financial-transaction";
import { projectContributionOut } from "./household-contribution";
import { ledgerAttributions } from "./ledger-party";
import {
  ledgerSourceClaimOut,
  ledgerSourceClaims,
  ledgerTransferCreateInput,
  ledgerTransferUpdateData,
} from "./ledger-transfer";

const claim = {
  source: "splitwise",
  normalizedEvidence: {
    amount: 12.34,
    occurredOn: "2026-08-23",
    description: "Shared dinner",
    context: null,
    disambiguator: null,
  },
  reconciliation: { decision: "amounts_match" as const },
};

describe("ledger contracts", () => {
  it("keeps same-party transfers as valid derived internal moves", () => {
    expect(
      ledgerTransferCreateInput.safeParse({
        fromPartyId: "LPY-A234",
        toPartyId: "LPY-A234",
        amount: 12.34,
        date: "2026-08-23",
        sourceClaims: [claim],
        evidenceTransactionIds: [],
      }).success,
    ).toBe(true);
  });

  it("distinguishes omitted replacement sets from explicit clearing", () => {
    expect(ledgerTransferUpdateData.parse({})).toEqual({});
    expect(ledgerTransferUpdateData.parse({ sourceClaims: null })).toEqual({
      sourceClaims: null,
    });
    expect(
      ledgerTransferUpdateData.parse({ evidenceTransactionIds: null }),
    ).toEqual({
      evidenceTransactionIds: null,
    });
  });

  it("uses canonical evidence without a raw provider payload or source uuid", () => {
    expect(
      ledgerTransferCreateInput.safeParse({
        fromPartyId: "LPY-A234",
        toPartyId: "LPY-B234",
        amount: 1,
        date: "2026-08-23",
        sourceClaims: [claim],
        evidenceTransactionIds: [],
      }).success,
    ).toBe(true);
    expect(
      ledgerTransferCreateInput.safeParse({
        fromPartyId: "LPY-A234",
        toPartyId: "LPY-B234",
        amount: 1,
        date: "2026-08-23",
        sourceClaims: [{ ...claim, rawPayload: "forbidden" }],
        evidenceTransactionIds: [],
      }).success,
    ).toBe(false);
    expect(ledgerSourceClaimOut.shape).not.toHaveProperty("id");
    expect(ledgerSourceClaimOut.shape).not.toHaveProperty("providerId");
  });

  it("dedupes provider identities before canonical evidence", () => {
    expect(
      ledgerSourceClaims.safeParse([
        { ...claim, providerId: "row-1" },
        {
          ...claim,
          providerId: "row-1",
          normalizedEvidence: { ...claim.normalizedEvidence, amount: 99 },
        },
      ]).success,
    ).toBe(false);
    expect(ledgerSourceClaims.safeParse([claim, { ...claim }]).success).toBe(
      false,
    );
  });

  it("bounds unitless attribution weights and keeps transaction transfer links read-only", () => {
    expect(
      ledgerAttributions.safeParse([{ partyId: "LPY-A234", weight: 1 }])
        .success,
    ).toBe(true);
    expect(
      ledgerAttributions.safeParse([
        { partyId: "LPY-A234", weight: 7_000_000_000 },
      ]).success,
    ).toBe(true);
    expect(
      ledgerAttributions.safeParse([
        { partyId: "LPY-A234", weight: Number.MAX_SAFE_INTEGER + 1 },
      ]).success,
    ).toBe(false);
    expect(
      financialTransactionCreateInput.safeParse({
        accountId: "FAC-A234",
        kind: "other",
        status: "pending",
        amount: 1,
        transactionDate: null,
        postedDate: null,
        merchant: null,
        rawDescription: null,
        sourceCategory: null,
        sourceRefs: [],
        notes: null,
        ledgerTransferId: "LTR-A234",
      }).success,
    ).toBe(false);
  });

  it("keeps project gaps scoped to Expense records", () => {
    const report = {
      projectId: "PRJ-A234",
      wholeGroupCost: 0,
      householdInitialExposure: 0,
      guestInitialFunding: 0,
      unattributedConsumption: 0,
      unattributedInitialFunding: 0,
      householdConsumed: 0,
      parties: [],
      funders: [],
    };
    expect(
      projectContributionOut.safeParse({
        ...report,
        gaps: [
          {
            code: "missing_funders",
            targetIds: ["EXP-A234"],
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      projectContributionOut.safeParse({
        ...report,
        gaps: [
          {
            code: "transfer_evidence_one_sided",
            targetIds: ["LTR-A234"],
          },
        ],
      }).success,
    ).toBe(false);
  });
});
