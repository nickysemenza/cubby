import { testShortcode } from "@cubby/schemas/testing";
import { describe, expect, it } from "vitest";
import { buildFinancialTransferPairSuggestions } from "./financial-transfer-pairing";

const transactionShortcode = (seed: string) =>
  testShortcode("financialTransaction", seed);
const accountShortcode = (seed: string) =>
  testShortcode("financialAccount", seed);

describe("buildFinancialTransferPairSuggestions", () => {
  it("suggests one opposite, different-account evidence leg", () => {
    const suggestions = buildFinancialTransferPairSuggestions(
      [
        {
          id: "outflow-id",
          shortcode: transactionShortcode("FTX-OUTFLOW"),
          accountId: "account-a",
          accountShortcode: accountShortcode("FAC-A"),
          amount: 120,
          date: "2026-08-20",
          party: { kind: "member", id: "LPY-A" as never, name: "Alex" },
        },
      ],
      [
        {
          id: "inflow-id",
          shortcode: transactionShortcode("FTX-INFLOW"),
          accountId: "account-b",
          accountShortcode: accountShortcode("FAC-B"),
          amount: -120,
          date: "2026-08-22",
          party: {
            kind: "household",
            id: "LPY-HOUSEHOLD" as never,
            name: "Household",
          },
        },
      ],
      { maxDateDistanceDays: 5, maxCandidatesPerTransaction: 3 },
    );

    expect(suggestions).toEqual([
      {
        transactionId: transactionShortcode("FTX-OUTFLOW"),
        status: "proposed",
        candidates: [
          expect.objectContaining({
            transactionId: transactionShortcode("FTX-INFLOW"),
            amount: 120,
            dateDistanceDays: 2,
            fromAccountId: accountShortcode("FAC-A"),
            toAccountId: accountShortcode("FAC-B"),
            from: { kind: "member", id: "LPY-A", name: "Alex" },
            to: {
              kind: "household",
              id: "LPY-HOUSEHOLD",
              name: "Household",
            },
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
          shortcode: transactionShortcode("FTX-TARGET"),
          accountId: "account-a",
          accountShortcode: accountShortcode("FAC-A"),
          amount: 20,
          date: "2026-08-20",
          party: null,
        },
      ],
      [
        {
          id: "same-direction",
          shortcode: transactionShortcode("FTX-SAME-DIRECTION"),
          accountId: "account-b",
          accountShortcode: accountShortcode("FAC-B"),
          amount: 20,
          date: "2026-08-20",
          party: null,
        },
        {
          id: "same-account",
          shortcode: transactionShortcode("FTX-SAME-ACCOUNT"),
          accountId: "account-a",
          accountShortcode: accountShortcode("FAC-A"),
          amount: -20,
          date: "2026-08-20",
          party: null,
        },
      ],
      { maxDateDistanceDays: 5, maxCandidatesPerTransaction: 3 },
    );

    expect(suggestions[0]).toMatchObject({
      transactionId: transactionShortcode("FTX-TARGET"),
      status: "no_match",
      candidates: [],
    });
  });

  it("does not suggest a pair for requested evidence already allocated or paired", () => {
    const suggestions = buildFinancialTransferPairSuggestions(
      [
        {
          id: "already-used",
          shortcode: transactionShortcode("FTX-ALREADY-USED"),
          accountId: "account-a",
          accountShortcode: "FAC-A",
          amount: 20,
          date: "2026-08-20",
          party: null,
          eligible: false,
        },
      ],
      [
        {
          id: "otherwise-match",
          shortcode: transactionShortcode("FTX-OTHER"),
          accountId: "account-b",
          accountShortcode: accountShortcode("FAC-B"),
          amount: -20,
          date: "2026-08-20",
          party: null,
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
      shortcode: transactionShortcode("FTX-TARGET"),
      accountId: "account-a",
      accountShortcode: accountShortcode("FAC-A"),
      amount: 20,
      date: "2026-08-20",
      party: null,
    };
    const suggestions = buildFinancialTransferPairSuggestions(
      [target],
      [
        {
          ...target,
          id: "candidate-1",
          shortcode: transactionShortcode("FTX-C1"),
          accountId: "account-b",
          accountShortcode: accountShortcode("FAC-B"),
          amount: -20,
        },
        {
          ...target,
          id: "candidate-2",
          shortcode: transactionShortcode("FTX-C2"),
          accountId: "account-c",
          accountShortcode: accountShortcode("FAC-C"),
          amount: -20,
        },
      ],
      { maxDateDistanceDays: 5, maxCandidatesPerTransaction: 1 },
    );

    expect(suggestions[0]).toMatchObject({ status: "ambiguous" });
    expect(suggestions[0]?.candidates).toHaveLength(1);
  });
});
