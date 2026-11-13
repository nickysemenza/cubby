import { type ExpenseId } from "@cubby/schemas/identifiers";

export type Line = {
  id: ExpenseId;
  shortcode: string;
  title: string;
  amountMinor: bigint | null;
  lineKind: string;
  productId: string | null;
  projectId: string | null;
  productQuantity: number | null;
  attribution: string;
  /** Booking facts a retired line hands to its survivor when the survivor has none. */
  carried: Record<CarriedField, string | null>;
  economicRole: string;
};

const CARRIED_FIELDS = [
  "bookingTransactionCode",
  "spendingCategoryId",
  "trade",
] as const;

type CarriedField = (typeof CARRIED_FIELDS)[number];

const titleOf = (line: Line) =>
  line.title.trim().replace(/\s+/gu, " ").toLowerCase();

const centsOf = (line: Line) => line.amountMinor;

type Pair = {
  from: Line;
  to: Line;
  carry: Partial<Record<CarriedField, string>>;
};

/** One duplicate line onto one survivor line, or why that pairing would lose a fact. */
function pairOne(
  line: Line,
  to: Line,
  survivor: readonly Line[],
): Pair | { error: string } {
  const keeps = (from: unknown, into: unknown) =>
    from === null || from === into;
  if (
    !keeps(line.productId, to.productId) ||
    !keeps(line.projectId, to.projectId) ||
    !keeps(line.productQuantity, to.productQuantity) ||
    (line.attribution !== "[]" && line.attribution !== to.attribution)
  )
    return {
      error: `The duplicate line "${line.title}" carries a Product, Project, quantity or attribution the survivor's line does not.`,
    };
  const carry: Partial<Record<CarriedField, string>> = {};
  for (const field of CARRIED_FIELDS) {
    const value = line.carried[field];
    if (value === null || value === to.carried[field]) continue;
    if (to.carried[field] !== null)
      return {
        error: `The duplicate line "${line.title}" and its survivor line disagree on ${field}.`,
      };
    carry[field] = value;
  }
  // A booking code another survivor line already holds would book one charge twice.
  if (
    carry.bookingTransactionCode &&
    survivor.some(
      (other) =>
        other.id !== to.id &&
        other.carried.bookingTransactionCode === carry.bookingTransactionCode,
    )
  )
    return {
      error: `The duplicate line "${line.title}" carries a booking another survivor line already holds.`,
    };
  // Only principal lines carry a spending category.
  if (carry.spendingCategoryId && to.lineKind !== "principal")
    return {
      error: `The duplicate line "${line.title}" carries a spending category its survivor's ${to.lineKind} line cannot hold.`,
    };
  return { from: line, to, carry };
}

/**
 * Booking-fact matches outrank title matches, which outrank role matches,
 * across a whole assignment: each tier's weight exceeds the most any lower
 * tier can add for a group of at most PAIRING_GROUP_MAX lines.
 */
const pairScore = (pair: Pair) =>
  (JSON.stringify(pair.from.carried) === JSON.stringify(pair.to.carried)
    ? 100
    : 0) +
  (titleOf(pair.from) === titleOf(pair.to) ? 10 : 0) +
  (pair.from.lineKind === pair.to.lineKind ? 1 : 0);

/** The best complete assignment found so far for one amount. */
type PairingSearch = {
  best: { score: number; pairs: Pair[] } | null;
  tied: boolean;
  firstError: string | null;
};

/** Most lines of one amount the exhaustive assignment search accepts. */
const PAIRING_GROUP_MAX = 8;

/**
 * Pair every duplicate line with one survivor line of the same amount: money
 * pairs by cents, since two documents may title or classify a line
 * differently. Within each amount, every valid one-to-one assignment is
 * scored and the best wins; two different best assignments are ambiguous and
 * refuse, so row order never decides which line a source binds to. The
 * survivor keeps its own description.
 */
export function pairLines(duplicate: Line[], survivor: Line[]) {
  if (duplicate.length !== survivor.length)
    return { error: "The two Purchases hold different numbers of lines." };
  const groups = new Map<string, { from: Line[]; to: Line[] }>();
  const group = (line: Line) => {
    const key = String(centsOf(line));
    const found = groups.get(key) ?? { from: [], to: [] };
    groups.set(key, found);
    return found;
  };
  for (const line of duplicate) group(line).from.push(line);
  for (const line of survivor) group(line).to.push(line);
  const pairs: Pair[] = [];
  for (const { from, to } of groups.values()) {
    if (from.length !== to.length)
      return {
        error: `The duplicate line "${(from[0] ?? to[0])!.title}" has no survivor line of the same amount.`,
      };
    if (from.length > PAIRING_GROUP_MAX)
      return {
        error: `More than ${PAIRING_GROUP_MAX} lines share one amount; pair them by review.`,
      };
    const state: PairingSearch = { best: null, tied: false, firstError: null };
    const used = new Set<number>();
    const chosen: Pair[] = [];
    const search = (index: number, score: number) => {
      if (index === from.length) {
        if (!state.best || score > state.best.score) {
          state.best = { score, pairs: [...chosen] };
          state.tied = false;
        } else if (score === state.best.score) state.tied = true;
        return;
      }
      for (const [position, candidate] of to.entries()) {
        if (used.has(position)) continue;
        const pair = pairOne(from[index]!, candidate, survivor);
        if ("error" in pair) {
          state.firstError ??= pair.error;
          continue;
        }
        used.add(position);
        chosen.push(pair);
        search(index + 1, score + pairScore(pair));
        chosen.pop();
        used.delete(position);
      }
    };
    search(0, 0);
    const found = state.best;
    if (!found)
      return {
        error:
          state.firstError ?? "The duplicate lines do not match the survivor.",
      };
    if (state.tied)
      return {
        error: `Lines of one amount ("${from[0]!.title}") pair equally well more than one way; converge them by review.`,
      };
    pairs.push(...found.pairs);
  }
  return { pairs };
}

/** Reads: both live Purchase vendorId/vendorAccountId/orderId/date, normalized order keys, all linked Email mailbox/thread identities, accepted duplicate source-order existence and duplicate financial-source-claim existence. */
export function duplicateSourceOrderRefusal(input: {
  survivor: {
    vendorId: string;
    vendorAccountId: string | null;
    orderId: string | null;
    date: string | null;
  };
  duplicate: {
    vendorId: string;
    vendorAccountId: string | null;
    orderId: string | null;
    date: string | null;
  };
  survivorOrderKey: string | null;
  duplicateOrderKey: string | null;
  sharesThread: boolean;
  hasSourceOrder: boolean;
  hasClaimedLine: boolean;
  duplicateLines: readonly Line[];
  survivorLines: readonly Line[];
}) {
  const { survivor, duplicate } = input;
  if (survivor.vendorId !== duplicate.vendorId)
    return {
      code: "PURCHASE_MERGE_VENDOR_MISMATCH" as const,
      reason: "The two Purchases belong to different Vendors.",
    };
  if (
    survivor.vendorAccountId !== null &&
    duplicate.vendorAccountId !== null &&
    survivor.vendorAccountId !== duplicate.vendorAccountId
  )
    return {
      code: "PURCHASE_SOURCE_CONVERGENCE_REFUSED" as const,
      reason: "The two Purchases belong to different vendor accounts.",
    };
  if (
    survivor.orderId !== null &&
    duplicate.orderId !== null &&
    input.survivorOrderKey !== input.duplicateOrderKey
  )
    return {
      code: "PURCHASE_MERGE_ORDER_COLLISION" as const,
      reason: `The Purchases carry different order ids (${survivor.orderId}, ${duplicate.orderId}).`,
    };
  if (
    (survivor.orderId === null || duplicate.orderId === null) &&
    (!input.sharesThread || survivor.date !== duplicate.date)
  )
    return {
      code: "PURCHASE_SOURCE_CONVERGENCE_REFUSED" as const,
      reason:
        "The Purchases share no order id, and their source Emails share no thread and date; they may be two orders.",
    };
  if (!input.hasSourceOrder)
    return {
      code: "PURCHASE_SOURCE_CONVERGENCE_REFUSED" as const,
      reason: "The duplicate Purchase has no accepted source order to move.",
    };
  if (
    [...input.duplicateLines, ...input.survivorLines].some(
      (line) => line.economicRole !== "vendor",
    )
  )
    return {
      code: "PURCHASE_SOURCE_CONVERGENCE_REFUSED" as const,
      reason:
        "Only vendor lines converge; reimbursement lines need their own review.",
    };
  if (input.hasClaimedLine)
    return {
      code: "PURCHASE_SOURCE_CONVERGENCE_REFUSED" as const,
      reason:
        "A duplicate line carries financial source claims; correct its booking instead.",
    };
  return null;
}

/** Reads: EntityIdentity id/mergedIntoId for the duplicate shortcode and this command's AuditLog convergence receipt on the survivor, including either missing row. */
export function duplicateSourceOrderReplay(input: {
  identity: { id: string; mergedIntoId: string | null } | null;
  survivorId: string;
  survivorCode: string;
  duplicateCode: string;
  hasReceipt: boolean;
}) {
  if (!input.identity)
    return {
      kind: "refused" as const,
      code: "PURCHASE_NOT_FOUND" as const,
      reason: `Purchase not found: ${input.duplicateCode}`,
    };
  if (input.identity.mergedIntoId === input.survivorId)
    return input.hasReceipt
      ? { kind: "already_applied" as const }
      : {
          kind: "refused" as const,
          code: "PURCHASE_SOURCE_CONVERGENCE_REFUSED" as const,
          reason: `${input.duplicateCode} was merged into ${input.survivorCode} without converging its lines; review the survivor's line sets.`,
        };
  if (input.identity.id === input.survivorId)
    return {
      kind: "refused" as const,
      code: "PURCHASE_SOURCE_CONVERGENCE_REFUSED" as const,
      reason: "Name two different Purchases.",
    };
  return { kind: "continue" as const, identity: input.identity };
}
