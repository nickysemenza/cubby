import { describe, expect, it } from "vitest";

import {
  buildPurchaseSpendingEvents,
  type PurchaseSpendingAllocationInput,
  type PurchaseSpendingLineInput,
} from "./purchase-spending";

const purchase = (
  overrides: Partial<{ date: string | null; statedTotal: number | null }> = {},
) => ({ date: "2026-03-01", statedTotal: null, ...overrides });

const line = (
  id: string,
  cost: number | null,
  overrides: Partial<PurchaseSpendingLineInput> = {},
): PurchaseSpendingLineInput => ({
  id,
  cost,
  date: "2026-03-01",
  lineKind: "principal",
  future: false,
  claimDates: [],
  ...overrides,
});

const allocation = (
  id: string,
  kind: string,
  amount: number,
  transactionDate: string | null,
): PurchaseSpendingAllocationInput => ({
  id,
  kind,
  amount,
  transactionDate,
  postedDate: null,
});

const summary = (events: ReturnType<typeof buildPurchaseSpendingEvents>) =>
  events.map((event) => ({
    occurrence: event.occurrence,
    date: event.date,
    amount: event.amount,
    basis: event.basis,
    ledgerAmount: event.ledgerAmount,
    lines: event.lines.map(({ line }) => line.id),
    settlements: event.settlements.map(({ id }) => id),
  }));

describe("buildPurchaseSpendingEvents original event", () => {
  it("prefers the stated total but keeps ledger spend to Expense lines", () => {
    const events = buildPurchaseSpendingEvents(
      purchase({ statedTotal: 30 }),
      [
        line("a", 20.1),
        line("b", 9.9),
        line("disc", -2, { lineKind: "discount" }),
        line("plan", 50, { future: true }),
      ],
      [allocation("ftx", "purchase", 28, "2026-03-02")],
    );
    expect(summary(events)).toEqual([
      {
        occurrence: "original",
        date: "2026-03-01",
        amount: 30,
        basis: "stated_total",
        ledgerAmount: 28,
        lines: ["a", "b", "disc"],
        settlements: [],
      },
    ]);
  });

  it("falls back to positive non-refund allocations, dated by the charge", () => {
    const events = buildPurchaseSpendingEvents(
      purchase({ date: null }),
      [],
      [
        allocation("charge", "purchase", 12.34, "2026-03-04"),
        allocation("fee", "fee", 1, "2026-03-05"),
        allocation("credit", "adjustment", -3, "2026-03-03"),
      ],
    );
    expect(summary(events)).toEqual([
      {
        occurrence: "original",
        date: "2026-03-04",
        amount: 13.34,
        basis: "settlement",
        ledgerAmount: 0,
        lines: [],
        settlements: ["charge", "fee"],
      },
    ]);
  });

  it("keeps an unpriced Purchase unknown rather than zero", () => {
    const [event] = buildPurchaseSpendingEvents(purchase(), [], []);
    expect(event).toMatchObject({
      amount: null,
      basis: "unknown",
      ledgerAmount: 0,
    });
  });

  it("dates an undated Purchase by its earliest original line", () => {
    const [event] = buildPurchaseSpendingEvents(
      purchase({ date: null }),
      [
        line("b", 5, { date: "2026-03-09" }),
        line("a", 5, { date: "2026-03-07" }),
      ],
      [],
    );
    expect(event).toMatchObject({
      date: "2026-03-07",
      dateBasis: "expense_line",
    });
  });
});

describe("buildPurchaseSpendingEvents refunds", () => {
  it("dates refund lines by own date, then claim, then matching settlement", () => {
    const events = buildPurchaseSpendingEvents(
      purchase(),
      [
        line("item", 100),
        line("own", -10, { date: "2026-03-10" }),
        line("claimed", -20, { claimDates: ["2026-03-12"] }),
        line("settled", -30),
        line("stored", -40, { lineKind: "unclassified" }),
      ],
      [
        allocation("r-own", "refund", -10, "2026-03-11"),
        allocation("r-settled", "refund", -30, "2026-03-15"),
      ],
    );
    expect(summary(events)).toEqual([
      expect.objectContaining({ occurrence: "original", ledgerAmount: 100 }),
      {
        occurrence: "refund",
        date: "2026-03-01",
        amount: -40,
        basis: "expense_lines",
        ledgerAmount: -40,
        lines: ["stored"],
        settlements: [],
      },
      expect.objectContaining({
        date: "2026-03-10",
        amount: -10,
        settlements: [],
      }),
      expect.objectContaining({ date: "2026-03-12", amount: -20 }),
      expect.objectContaining({
        date: "2026-03-15",
        amount: -30,
        lines: ["settled"],
      }),
    ]);
  });

  it("uses refund allocations grouped by date when no refund lines exist", () => {
    const events = buildPurchaseSpendingEvents(
      purchase({ statedTotal: 50 }),
      [],
      [
        allocation("r1", "refund", -5, "2026-03-20"),
        allocation("r2", "refund", -7.5, "2026-03-20"),
        allocation("r3", "refund", -1, "2026-03-22"),
      ],
    );
    expect(summary(events).slice(1)).toEqual([
      {
        occurrence: "refund",
        date: "2026-03-20",
        amount: -12.5,
        basis: "settlement",
        ledgerAmount: 0,
        lines: [],
        settlements: ["r1", "r2"],
      },
      expect.objectContaining({
        date: "2026-03-22",
        amount: -1,
        ledgerAmount: 0,
      }),
    ]);
  });

  it("deduplicates one settlement covering several same-day refund lines", () => {
    const events = buildPurchaseSpendingEvents(
      purchase(),
      [
        line("item", 50),
        line("r1", -10, { claimDates: ["2026-03-05"] }),
        line("r2", -5, { claimDates: ["2026-03-05"] }),
      ],
      [allocation("combined", "refund", -15, "2026-03-05")],
    );
    expect(summary(events)[1]).toMatchObject({
      date: "2026-03-05",
      amount: -15,
      ledgerAmount: -15,
      settlements: [],
    });
  });

  it("deduplicates the whole remainder and borrows its single date", () => {
    const events = buildPurchaseSpendingEvents(
      purchase(),
      [line("item", 50), line("r1", -10), line("r2", -5)],
      [allocation("combined", "refund", -15, "2026-03-08")],
    );
    expect(events.slice(1)).toEqual([
      expect.objectContaining({
        date: "2026-03-08",
        amount: -15,
        dateBasis: "settlement",
        settlements: [],
        ambiguities: [],
      }),
    ]);
  });

  it("keeps an unmatched settlement visible beside refund lines", () => {
    const events = buildPurchaseSpendingEvents(
      purchase(),
      [line("item", 50), line("r1", -10, { date: "2026-03-06" })],
      [
        allocation("match", "refund", -10, "2026-03-06"),
        allocation("extra", "refund", -4, "2026-03-06"),
      ],
    );
    expect(events[1]).toMatchObject({
      date: "2026-03-06",
      amount: -14,
      ledgerAmount: -10,
      settlements: [expect.objectContaining({ id: "extra" })],
      ambiguities: [expect.stringContaining("match no refund line")],
    });
  });

  it("consumes each settlement once and reports an unresolved date", () => {
    const events = buildPurchaseSpendingEvents(
      purchase(),
      [line("item", 50), line("r1", -10)],
      [
        allocation("a", "refund", -10, "2026-03-02"),
        allocation("b", "refund", -10, "2026-03-04"),
      ],
    );
    const refunds = events.slice(1);
    expect(
      refunds.reduce((total, event) => total + (event.amount ?? 0), 0),
    ).toBe(-20);
    expect(refunds.flatMap((event) => event.ambiguities)).toEqual([
      expect.stringContaining("2 same-amount refund settlements"),
      expect.stringContaining("match no refund line"),
    ]);
  });

  it("omits the original for a return-only Purchase", () => {
    const events = buildPurchaseSpendingEvents(purchase(), [line("r", -8)], []);
    expect(summary(events)).toEqual([
      expect.objectContaining({ occurrence: "refund", amount: -8 }),
    ]);
  });
});
