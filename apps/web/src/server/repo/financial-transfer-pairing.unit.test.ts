import { describe, expect, it } from "vitest";
import { buildFinancialTransferPairSuggestions } from "./financial-transfer-pairing";

describe("buildFinancialTransferPairSuggestions", () => {
  it("suggests one opposite, different-account evidence leg", () => {
    const suggestions = buildFinancialTransferPairSuggestions(
      [
        {
          id: "outflow-id",
          shortcode: "FTX-OUTFLOW",
          accountId: "account-a",
          accountShortcode: "FAC-A",
          amount: 120,
          date: "2026-08-20",
          fundingParty: { kind: "person", id: "PER-A" as never },
        },
      ],
      [
        {
          id: "inflow-id",
          shortcode: "FTX-INFLOW",
          accountId: "account-b",
          accountShortcode: "FAC-B",
          amount: -120,
          date: "2026-08-22",
          fundingParty: { kind: "fund", key: "household-checking" },
        },
      ],
      { maxDateDistanceDays: 5, maxCandidatesPerTransaction: 3 },
    );

    expect(suggestions).toEqual([
      {
        transactionId: "FTX-OUTFLOW",
        status: "proposed",
        candidates: [
          expect.objectContaining({
            transactionId: "FTX-INFLOW",
            amount: 120,
            dateDistanceDays: 2,
            fromAccountId: "FAC-A",
            toAccountId: "FAC-B",
            from: { kind: "person", id: "PER-A" },
            to: { kind: "fund", key: "household-checking" },
          }),
        ],
      },
    ]);
  });

  it("does not confuse equal same-direction evidence or same-account activity for a transfer", () => {
    const suggestions = buildFinancialTransferPairSuggestions(
      [
        {
          id: "target",
          shortcode: "FTX-TARGET",
          accountId: "account-a",
          accountShortcode: "FAC-A",
          amount: 20,
          date: "2026-08-20",
          fundingParty: null,
        },
      ],
      [
        {
          id: "same-direction",
          shortcode: "FTX-SAME-DIRECTION",
          accountId: "account-b",
          accountShortcode: "FAC-B",
          amount: 20,
          date: "2026-08-20",
          fundingParty: null,
        },
        {
          id: "same-account",
          shortcode: "FTX-SAME-ACCOUNT",
          accountId: "account-a",
          accountShortcode: "FAC-A",
          amount: -20,
          date: "2026-08-20",
          fundingParty: null,
        },
      ],
      { maxDateDistanceDays: 5, maxCandidatesPerTransaction: 3 },
    );

    expect(suggestions[0]).toMatchObject({
      transactionId: "FTX-TARGET",
      status: "no_match",
      candidates: [],
    });
  });

  it("does not suggest a pair for requested evidence already allocated or paired", () => {
    const suggestions = buildFinancialTransferPairSuggestions(
      [
        {
          id: "already-used",
          shortcode: "FTX-ALREADY-USED",
          accountId: "account-a",
          accountShortcode: "FAC-A",
          amount: 20,
          date: "2026-08-20",
          fundingParty: null,
          eligible: false,
        },
      ],
      [
        {
          id: "otherwise-match",
          shortcode: "FTX-OTHER",
          accountId: "account-b",
          accountShortcode: "FAC-B",
          amount: -20,
          date: "2026-08-20",
          fundingParty: null,
        },
      ],
      { maxDateDistanceDays: 5, maxCandidatesPerTransaction: 3 },
    );

    expect(suggestions[0]).toMatchObject({
      status: "no_match",
      candidates: [],
    });
  });

  it("keeps an ambiguous result ambiguous after limiting its displayed candidates", () => {
    const target = {
      id: "target",
      shortcode: "FTX-TARGET",
      accountId: "account-a",
      accountShortcode: "FAC-A",
      amount: 20,
      date: "2026-08-20",
      fundingParty: null,
    };
    const suggestions = buildFinancialTransferPairSuggestions(
      [target],
      [
        {
          ...target,
          id: "candidate-1",
          shortcode: "FTX-C1",
          accountId: "account-b",
          accountShortcode: "FAC-B",
          amount: -20,
        },
        {
          ...target,
          id: "candidate-2",
          shortcode: "FTX-C2",
          accountId: "account-c",
          accountShortcode: "FAC-C",
          amount: -20,
        },
      ],
      { maxDateDistanceDays: 5, maxCandidatesPerTransaction: 1 },
    );

    expect(suggestions[0]).toMatchObject({ status: "ambiguous" });
    expect(suggestions[0]?.candidates).toHaveLength(1);
  });
});
