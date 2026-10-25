// Pure Purchase spending rollup: one original event per Purchase plus one
// refund event per refund date. Alias-free so it runs in the unit project.
//
// Two amounts per event, deliberately separate:
//   - `amount` is the display amount: receipt `statedTotal`, else the original
//     Expense lines, else settlement allocations. Null means unknown, not zero.
//   - `ledgerAmount` is SUM(Expense.cost) of the event's own lines only. Spend
//     totals use it (README tenet: spend is always SUM Expense.cost), so a
//     settlement-only or stated-total event never inflates ledger spend.
import type { ExpenseLineKind } from "@cubby/schemas/expense-line-kind";
import { cents, dollars } from "@cubby/shared";

export type PurchaseSpendingPurchaseInput = {
  date: string | null;
  statedTotal: number | null;
};

/** A live Expense on the Purchase. `claimDates` are its live source-claim `occurredOn` values. */
export type PurchaseSpendingLineInput = {
  id: string;
  cost: number | null;
  date: string | null;
  lineKind: ExpenseLineKind;
  future: boolean;
  claimDates: readonly string[];
};

/** A live, non-void settlement allocation; `amount` is this Purchase's share. */
export type PurchaseSpendingAllocationInput = {
  id: string;
  kind: string;
  amount: number;
  transactionDate: string | null;
  postedDate: string | null;
};

type PurchaseSpendingOccurrence = "original" | "refund";
type PurchaseSpendingAmountBasis =
  | "stated_total"
  | "expense_lines"
  | "settlement"
  | "unknown";
type PurchaseSpendingDateBasis =
  | "purchase"
  | "expense_line"
  | "source_claim"
  | "settlement";

type PurchaseSpendingLineContribution<L> = {
  line: L;
  dateBasis: PurchaseSpendingDateBasis;
  /** The refund allocation deduplicated against this line, when one was. */
  settlement: PurchaseSpendingAllocationInput | null;
};

export type PurchaseSpendingEvent<
  P extends PurchaseSpendingPurchaseInput,
  L extends PurchaseSpendingLineInput,
> = {
  purchase: P;
  occurrence: PurchaseSpendingOccurrence;
  date: string;
  /** Display amount; refunds are negative. Null when no evidence prices it. */
  amount: number | null;
  basis: PurchaseSpendingAmountBasis;
  dateBasis: PurchaseSpendingDateBasis;
  /** SUM(Expense.cost) over `lines`; 0 when the event has no priced lines. */
  ledgerAmount: number;
  lines: PurchaseSpendingLineContribution<L>[];
  /** Allocations that priced this event without a matching Expense line. */
  settlements: PurchaseSpendingAllocationInput[];
  /** Evidence the rollup could not resolve uniquely; the event still renders. */
  ambiguities: string[];
};

const sumCents = (values: readonly number[]) =>
  values.reduce((total, value) => total + cents(value), 0);

const earliest = (dates: readonly (string | null)[]): string | null =>
  dates.reduce<string | null>(
    (min, date) => (date !== null && (min === null || date < min) ? date : min),
    null,
  );

const allocationDate = (
  allocation: PurchaseSpendingAllocationInput,
): string | null => allocation.transactionDate ?? allocation.postedDate;

/**
 * Money returned for an item. Negative discount, tax, fee and other
 * adjustments belong to the original order total.
 */
const isRefundPurchaseLine = (line: PurchaseSpendingLineInput) =>
  !line.future &&
  line.cost !== null &&
  line.cost < 0 &&
  (line.lineKind === "principal" || line.lineKind === "unclassified");

const isOriginalPurchaseLine = (line: PurchaseSpendingLineInput) =>
  !line.future && !isRefundPurchaseLine(line);

const isRefundAllocation = (allocation: PurchaseSpendingAllocationInput) =>
  allocation.kind === "refund";

const isOriginalAllocation = (allocation: PurchaseSpendingAllocationInput) =>
  !isRefundAllocation(allocation) && allocation.amount > 0;

/**
 * Refund date evidence carried by the line itself. A line date equal to the
 * Purchase date is usually inherited from the order, so it does not count.
 */
const refundEvidenceDate = (
  line: PurchaseSpendingLineInput,
  purchaseDate: string | null,
): { date: string; dateBasis: PurchaseSpendingDateBasis } | null => {
  if (line.date !== null && line.date !== purchaseDate)
    return { date: line.date, dateBasis: "expense_line" };
  const claimDate = earliest(line.claimDates);
  return claimDate === null
    ? null
    : { date: claimDate, dateBasis: "source_claim" };
};

function buildOriginalPurchaseEvent<
  P extends PurchaseSpendingPurchaseInput,
  L extends PurchaseSpendingLineInput,
>(
  purchase: P,
  lines: readonly L[],
  allocations: readonly PurchaseSpendingAllocationInput[],
): PurchaseSpendingEvent<P, L> | null {
  const originalLines = lines.filter(isOriginalPurchaseLine);
  const pricedLines = originalLines.filter((line) => line.cost !== null);
  const originalAllocations = allocations.filter(isOriginalAllocation);
  const hasRefundEvidence =
    lines.some(isRefundPurchaseLine) || allocations.some(isRefundAllocation);
  // A return-only Purchase renders its refunds without an empty original.
  if (
    purchase.statedTotal === null &&
    originalLines.length === 0 &&
    originalAllocations.length === 0 &&
    hasRefundEvidence
  )
    return null;

  const lineDate = earliest(originalLines.map((line) => line.date));
  const settlementDate = earliest(originalAllocations.map(allocationDate));
  const [date, dateBasis]: [string | null, PurchaseSpendingDateBasis] =
    purchase.date !== null
      ? [purchase.date, "purchase"]
      : lineDate !== null
        ? [lineDate, "expense_line"]
        : [settlementDate, "settlement"];
  if (date === null) return null;

  const ledgerCents = sumCents(pricedLines.map((line) => line.cost ?? 0));
  const [amount, basis]: [number | null, PurchaseSpendingAmountBasis] =
    purchase.statedTotal !== null
      ? [purchase.statedTotal, "stated_total"]
      : pricedLines.length > 0
        ? [dollars(ledgerCents), "expense_lines"]
        : originalAllocations.length > 0
          ? [
              dollars(sumCents(originalAllocations.map((a) => a.amount))),
              "settlement",
            ]
          : [null, "unknown"];

  return {
    purchase,
    occurrence: "original",
    date,
    amount,
    basis,
    dateBasis,
    ledgerAmount: dollars(ledgerCents),
    lines: originalLines.map((line) => ({
      line,
      dateBasis,
      settlement: null,
    })),
    settlements: basis === "settlement" ? originalAllocations : [],
    ambiguities: [],
  };
}

type RefundPlacement<L> = PurchaseSpendingLineContribution<L> & {
  date: string;
  ambiguity: string | null;
};

/**
 * Pair refund lines with refund allocations so the same money is never shown
 * twice. A pair needs evidence, in order: equal cents (one line, one
 * allocation); equal date and summed cents (several lines, one allocation);
 * the whole remaining refund total. Anything left over renders on its own.
 */
function buildRefundPurchaseEvents<
  P extends PurchaseSpendingPurchaseInput,
  L extends PurchaseSpendingLineInput,
>(
  purchase: P,
  lines: readonly L[],
  allocations: readonly PurchaseSpendingAllocationInput[],
): PurchaseSpendingEvent<P, L>[] {
  const refundLines = lines
    .filter(isRefundPurchaseLine)
    .sort((a, b) => a.id.localeCompare(b.id));
  // An undated refund allocation falls back to the Purchase date; with
  // neither it has no calendar position and is omitted.
  const refundAllocations = allocations
    .filter(isRefundAllocation)
    .flatMap((allocation) => {
      const date = allocationDate(allocation) ?? purchase.date;
      return date === null ? [] : [{ allocation, date }];
    })
    .sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        a.allocation.id.localeCompare(b.allocation.id),
    );
  const consumed = new Set<PurchaseSpendingAllocationInput>();
  const unconsumed = () =>
    refundAllocations.filter(({ allocation }) => !consumed.has(allocation));
  const placements = new Map<L, RefundPlacement<L>>();
  const evidence = new Map(
    refundLines.map((line) => [line, refundEvidenceDate(line, purchase.date)]),
  );
  // Refund lines always carry a date: the Expense_date_cost_check forbids a
  // priced, undated line.
  const storedDate = (line: L) => line.date ?? purchase.date ?? "";
  const place = (
    line: L,
    settlement: PurchaseSpendingAllocationInput | null,
    settlementDate: string | null,
    ambiguity: string | null = null,
  ) => {
    const own = evidence.get(line) ?? null;
    placements.set(line, {
      line,
      settlement,
      ambiguity,
      ...(own ??
        (settlementDate !== null
          ? { date: settlementDate, dateBasis: "settlement" as const }
          : { date: storedDate(line), dateBasis: "expense_line" as const })),
    });
  };

  // 1. One line, one allocation, equal cents.
  for (const line of refundLines) {
    const lineCents = cents(Math.abs(line.cost ?? 0));
    const candidates = unconsumed().filter(
      ({ allocation }) => cents(Math.abs(allocation.amount)) === lineCents,
    );
    if (candidates.length === 0) continue;
    const own = evidence.get(line);
    const onEvidenceDate = own
      ? candidates.find(({ date }) => date === own.date)
      : undefined;
    const singleDate = new Set(candidates.map(({ date }) => date)).size === 1;
    const pick = onEvidenceDate ?? candidates[0];
    if (!pick) continue;
    consumed.add(pick.allocation);
    const resolved = onEvidenceDate !== undefined || singleDate;
    place(
      line,
      pick.allocation,
      resolved ? pick.date : null,
      resolved
        ? null
        : `Refund line ${line.id} matches ${candidates.length} same-amount refund settlements on different dates`,
    );
  }

  // 2. Several lines dated by their own evidence, one allocation that day.
  for (const { allocation, date } of unconsumed()) {
    const sameDay = refundLines.filter(
      (line) => !placements.has(line) && evidence.get(line)?.date === date,
    );
    if (
      sameDay.length > 0 &&
      sumCents(sameDay.map((line) => line.cost ?? 0)) ===
        cents(allocation.amount)
    ) {
      consumed.add(allocation);
      for (const line of sameDay) place(line, allocation, date);
    }
  }

  // 3. The whole remaining refund equals the whole remaining settlement.
  const restLines = refundLines.filter((line) => !placements.has(line));
  const restAllocations = unconsumed();
  if (
    restLines.length > 0 &&
    restAllocations.length > 0 &&
    sumCents(restLines.map((line) => line.cost ?? 0)) ===
      sumCents(restAllocations.map(({ allocation }) => allocation.amount))
  ) {
    const dates = new Set(restAllocations.map(({ date }) => date));
    const onlyDate =
      dates.size === 1 ? (restAllocations[0]?.date ?? null) : null;
    const settlement =
      restAllocations.length === 1
        ? (restAllocations[0]?.allocation ?? null)
        : null;
    for (const { allocation } of restAllocations) consumed.add(allocation);
    for (const line of restLines)
      place(
        line,
        settlement,
        onlyDate,
        onlyDate === null && !evidence.get(line)
          ? `Refund line ${line.id} is covered by refund settlements on ${dates.size} dates`
          : null,
      );
  }
  for (const line of refundLines)
    if (!placements.has(line)) place(line, null, null);

  const byDate = new Map<
    string,
    {
      lines: RefundPlacement<L>[];
      settlements: PurchaseSpendingAllocationInput[];
    }
  >();
  const group = (date: string) => {
    const existing = byDate.get(date);
    if (existing) return existing;
    const created = { lines: [], settlements: [] };
    byDate.set(date, created);
    return created;
  };
  for (const placement of placements.values())
    group(placement.date).lines.push(placement);
  for (const { allocation, date } of unconsumed())
    group(date).settlements.push(allocation);

  return [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, { lines: placed, settlements }]) => {
      const ledgerCents = sumCents(placed.map(({ line }) => line.cost ?? 0));
      const settlementCents = sumCents(settlements.map((a) => a.amount));
      const ambiguities = placed.flatMap(({ ambiguity }) =>
        ambiguity === null ? [] : [ambiguity],
      );
      // With refund lines present, a leftover settlement may duplicate a line
      // the evidence could not pair, so it stays visible but flagged.
      if (refundLines.length > 0 && settlements.length > 0)
        ambiguities.push(
          `${settlements.length} refund settlement(s) on ${date} match no refund line`,
        );
      return {
        purchase,
        occurrence: "refund" as const,
        date,
        amount: dollars(ledgerCents + settlementCents),
        basis:
          placed.length > 0
            ? ("expense_lines" as const)
            : ("settlement" as const),
        dateBasis: placed[0]?.dateBasis ?? ("settlement" as const),
        ledgerAmount: dollars(ledgerCents),
        lines: placed.map(({ line, dateBasis, settlement }) => ({
          line,
          dateBasis,
          settlement,
        })),
        settlements,
        ambiguities,
      };
    });
}

export function buildPurchaseSpendingEvents<
  P extends PurchaseSpendingPurchaseInput,
  L extends PurchaseSpendingLineInput,
>(
  purchase: P,
  lines: readonly L[],
  allocations: readonly PurchaseSpendingAllocationInput[],
): PurchaseSpendingEvent<P, L>[] {
  const original = buildOriginalPurchaseEvent(purchase, lines, allocations);
  return [
    ...(original ? [original] : []),
    ...buildRefundPurchaseEvents(purchase, lines, allocations),
  ];
}
