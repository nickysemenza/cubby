import { describe, expect, it } from "vitest";

import { decideLineWrite, matchCompletePaymentSet } from "./writer-policy";

describe("purchase import writer policy", () => {
  const lines = [
    { title: "Filter", amount: 18, lineKind: "principal" as const },
    { title: "Shipping", amount: 2, lineKind: "shipping" as const },
  ];

  it("attaches equivalent independently arriving item lines without duplicating spend", () => {
    expect(
      decideLineWrite(
        lines.map((line, index) => ({
          id: `expense-${index}`,
          title: line.title,
          amount: line.amount,
          lineKind: line.lineKind,
          productId: null,
          tradeId: null,
          projectId: null,
          costType: "materials",
          sourceClaimed: true,
        })),
        lines,
      ),
    ).toEqual({ kind: "no_op" });
  });

  it("does not attach an equivalent price when the owned Product quantity conflicts", () => {
    expect(
      decideLineWrite(
        [
          {
            id: "expense-quantity",
            title: "Filter",
            amount: 18,
            lineKind: "principal",
            productId: "product-filter",
            productQuantity: 2,
            lineBasis: "item_line",
            tradeId: null,
            projectId: null,
            costType: "materials",
            sourceClaimed: false,
          },
        ],
        [{ title: "Filter", amount: 18, lineKind: "principal", quantity: 3 }],
      ),
    ).toEqual({ kind: "conflict", reason: "duplicate_lines" });
  });

  it("requires explicit review of even an exact, unlinked, unclaimed principal aggregate", () => {
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
      kind: "review_aggregate",
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
        storedValue: false,
      },
      {
        id: "txn-2",
        amount: 8,
        occurredAt: new Date("2026-09-19T18:00:00Z"),
        cardLastFours: [],
        storedValue: false,
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
      storedValue: false,
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

  it("never settles a gift-card payment line against a card charge", () => {
    const giftLine = {
      amount: 13.59,
      chargedAt: "2026-09-19T10:00:00.000Z",
      tender: "stored_value" as const,
    };
    const giftCard = [giftLine];
    const cardCharge = {
      id: "txn-card",
      amount: 13.59,
      occurredAt: new Date("2026-09-19T18:00:00Z"),
      cardLastFours: ["2125"],
      storedValue: false,
    };
    const balanceDebit = {
      ...cardCharge,
      id: "txn-balance",
      cardLastFours: [],
      storedValue: true,
    };

    expect(matchCompletePaymentSet(giftCard, [cardCharge])).toBeNull();
    expect(
      matchCompletePaymentSet(giftCard, [cardCharge, balanceDebit]),
    ).toEqual([
      { transactionId: "txn-balance", paymentIndex: 0, amount: 13.59 },
    ]);
    expect(
      matchCompletePaymentSet(
        [{ ...giftLine, tender: "card" as const }],
        [balanceDebit],
      ),
    ).toBeNull();
  });
});
