// Derived from the zod enum rather than restated: this union and
// `productMovementKind` are the same contract, and a local copy silently
// diverges the moment a kind is added on one side.
import type { ProductMovementKind } from "@cubby/schemas/product";

export type ProductMovementClassification = {
  kind: ProductMovementKind;
  signedQuantity: number | null;
};

export type ProductMovementMarker = {
  date: string | null;
  signedQuantity: number | null;
};

export type ProductOwnershipInterval = {
  start: string;
  end: string;
};

/** Keep only the proven part of each interval visible in a date window. */
export function clipOwnershipIntervals(
  intervals: readonly ProductOwnershipInterval[],
  from: string,
  to: string,
): ProductOwnershipInterval[] {
  return intervals.flatMap((interval) => {
    if (interval.end < from || interval.start > to) return [];
    return [
      {
        start: interval.start < from ? from : interval.start,
        end: interval.end > to ? to : interval.end,
      },
    ];
  });
}

/**
 * Interpret one product-linked Expense using the canonical quantity-ledger
 * rule. Money decides direction when present; a zero or unknown cost leaves
 * the signed quantity as the fact.
 */
export function classifyProductMovement(
  cost: number | null,
  productQuantity: number | null,
): ProductMovementClassification {
  if (cost !== null && cost > 0) {
    return {
      kind: "acquired",
      signedQuantity:
        productQuantity === null ? null : Math.abs(productQuantity),
    };
  }
  if (cost !== null && cost < 0) {
    // Zero is the concession case — money back, item kept. Checked before the
    // exit branch because `-Math.abs(0)` is `-0`, which renders as "-0" and
    // compares false under `Object.is` against the 0 every consumer expects.
    if (productQuantity === 0) {
      return { kind: "adjusted", signedQuantity: 0 };
    }
    return {
      kind: "exited",
      signedQuantity:
        productQuantity === null ? null : -Math.abs(productQuantity),
    };
  }
  if (productQuantity !== null && productQuantity > 0) {
    return { kind: "acquired", signedQuantity: productQuantity };
  }
  if (productQuantity !== null && productQuantity < 0) {
    return {
      kind: cost === 0 ? "discarded" : "exited",
      signedQuantity: productQuantity,
    };
  }
  return { kind: "unknown", signedQuantity: null };
}

/**
 * Build only ownership spans that the recorded quantities prove. Once a
 * movement has no quantity, or the running balance would go negative, the
 * remaining history stays marker-only rather than inventing a balance.
 *
 * Undated quantified exits (a discard with no known date) keep the dated
 * history: ownership is proven up to the last dated movement and unknown
 * from there. Any other undated movement could fall anywhere in the balance
 * history, so it leaves no proven span.
 */
export function buildConfidentOwnershipIntervals(
  markers: readonly ProductMovementMarker[],
  today: string,
): ProductOwnershipEvidence {
  const undated = markers.filter((marker) => marker.date === null);
  if (
    undated.some(
      (marker) => marker.signedQuantity === null || marker.signedQuantity >= 0,
    )
  )
    return { intervals: [], confidenceLostAt: null, undatedExits: false };
  const dated = foldDatedOwnership(
    markers.flatMap((marker) =>
      marker.date === null
        ? []
        : [{ date: marker.date, signedQuantity: marker.signedQuantity }],
    ),
    today,
  );
  if (undated.length === 0 || dated.confidenceLostAt !== null)
    return {
      intervals: dated.intervals,
      confidenceLostAt: dated.confidenceLostAt,
      undatedExits: false,
    };
  if (dated.lastDate === null)
    return { intervals: [], confidenceLostAt: null, undatedExits: false };
  const lastDate = dated.lastDate;
  return {
    intervals: dated.intervals.map((interval) =>
      interval.end > lastDate ? { ...interval, end: lastDate } : interval,
    ),
    confidenceLostAt: lastDate,
    undatedExits: true,
  };
}

/** The fold over dated movements, with the last dated movement's date. */
interface DatedOwnershipFold {
  intervals: ProductOwnershipInterval[];
  confidenceLostAt: string | null;
  lastDate: string | null;
}

function foldDatedOwnership(
  markers: readonly { date: string; signedQuantity: number | null }[],
  today: string,
): DatedOwnershipFold {
  const totalsByDate = new Map<string, number | null>();
  for (const marker of markers) {
    const current = totalsByDate.get(marker.date);
    if (marker.signedQuantity === null || current === null) {
      totalsByDate.set(marker.date, null);
    } else {
      totalsByDate.set(marker.date, (current ?? 0) + marker.signedQuantity);
    }
  }
  const ordered = [...totalsByDate]
    .map(([date, signedQuantity]) => ({ date, signedQuantity }))
    .sort((left, right) => left.date.localeCompare(right.date));
  const intervals: ProductOwnershipInterval[] = [];
  let balance = 0;
  let openStart: string | null = null;

  const lastDate = ordered.at(-1)?.date ?? null;
  for (const marker of ordered) {
    if (marker.signedQuantity === null || balance + marker.signedQuantity < 0) {
      if (openStart !== null) {
        intervals.push({ start: openStart, end: marker.date });
      }
      return { intervals, confidenceLostAt: marker.date, lastDate };
    }

    const previous = balance;
    balance += marker.signedQuantity;
    if (previous === 0 && balance > 0) openStart = marker.date;
    if (previous > 0 && balance === 0 && openStart !== null) {
      intervals.push({ start: openStart, end: marker.date });
      openStart = null;
    }
  }

  if (openStart !== null) intervals.push({ start: openStart, end: today });
  return { intervals, confidenceLostAt: null, lastDate };
}

interface ProductOwnershipEvidence {
  intervals: ProductOwnershipInterval[];
  confidenceLostAt: string | null;
  /** Only undated quantified exits follow the proven history. */
  undatedExits: boolean;
}
