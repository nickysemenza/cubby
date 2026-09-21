import { describe, expect, it } from "vitest";

import {
  decideLineWrite,
  matchCompletePaymentSet,
  uniqueOrderSubsetForCharge,
} from "./writer-policy";

describe("purchase import writer policy", () => {
  const lines = [
    { title: "Filter", amount: 18, lineKind: "principal" as const },
    { title: "Shipping", amount: 2, lineKind: "shipping" as const },
  ];

  it("replaces only an exact, unlinked, unclaimed principal aggregate", () => {
    const decision = decideLineWrite(
      [
        {
          id: "expense-1",
          title: "House supplies",
          amount: 20,
          lineKind: "principal",
          productId: null,
          tradeId: "trade-1",
          projectId: "project-1",
          costType: "material",
          sourceClaimed: false,
        },
      ],
      lines,
    );

    expect(decision).toMatchObject({
      kind: "replace_aggregate",
      aggregate: { title: "House supplies", projectId: "project-1" },
    });
  });

  it.each([
    { productId: "product-1", sourceClaimed: false, amount: 20 },
    { productId: null, sourceClaimed: true, amount: 20 },
    { productId: null, sourceClaimed: false, amount: 19.99 },
  ])("refuses an unsafe aggregate shape", (override) => {
    expect(
      decideLineWrite(
        [
          {
            id: "expense-1",
            title: "Existing evidence",
            lineKind: "principal",
            tradeId: null,
            projectId: null,
            costType: null,
            ...override,
          },
        ],
        lines,
      ),
    ).toEqual({ kind: "conflict", reason: "duplicate_lines" });
  });

  it("settles only when every payment has one distinct match", () => {
    const payments = [
      { amount: 12, chargedAt: "2026-09-18T10:00:00.000Z" },
      { amount: 8, chargedAt: "2026-09-19T10:00:00.000Z" },
    ];
    const transactions = [
      {
        id: "txn-1",
        amount: 12,
        occurredAt: new Date("2026-09-18T18:00:00Z"),
        cardLastFours: [],
      },
      {
        id: "txn-2",
        amount: 8,
        occurredAt: new Date("2026-09-19T18:00:00Z"),
        cardLastFours: [],
      },
    ];

    expect(matchCompletePaymentSet(payments, transactions)).toHaveLength(2);
    expect(
      matchCompletePaymentSet(payments, transactions.slice(0, 1)),
    ).toBeNull();
  });

  it("matches receipt digits against any card the account carried, and stays out on a tie", () => {
    const payment = [
      {
        amount: 226.05,
        chargedAt: "2026-09-19T10:00:00.000Z",
        cardLastFour: "4700",
      },
    ];
    const walletCharge = {
      id: "txn-atmos",
      amount: 226.05,
      occurredAt: new Date("2026-09-19T18:00:00Z"),
      // Statement labels the account ...2125; the terminal saw the Apple Pay
      // device number 4700.
      cardLastFours: ["2125", "4700"],
    };
    const otherCard = {
      ...walletCharge,
      id: "txn-other",
      cardLastFours: ["2125"],
    };

    expect(matchCompletePaymentSet(payment, [walletCharge, otherCard])).toEqual(
      [{ transactionId: "txn-atmos", paymentIndex: 0, amount: 226.05 }],
    );
    expect(matchCompletePaymentSet(payment, [otherCard])).toBeNull();
    expect(
      matchCompletePaymentSet(payment, [
        walletCharge,
        { ...walletCharge, id: "txn-twin" },
      ]),
    ).toBeNull();
  });

  it("returns only a unique subset of distinct orders", () => {
    expect(
      uniqueOrderSubsetForCharge(30, [
        { id: "a", amount: 10 },
        { id: "b", amount: 20 },
        { id: "c", amount: 40 },
      ]),
    ).toEqual([
      { id: "a", amount: 10 },
      { id: "b", amount: 20 },
    ]);
    expect(
      uniqueOrderSubsetForCharge(20, [
        { id: "a", amount: 20 },
        { id: "b", amount: 10 },
        { id: "c", amount: 10 },
      ]),
    ).toBeNull();
  });
});
