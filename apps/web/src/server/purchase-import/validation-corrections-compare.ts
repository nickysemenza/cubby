import { shortcodeSchema } from "@cubby/schemas/identifiers";
import type {
  ValidationCorrection,
  ValidationExpectedPlan,
  ValidationNote,
  ValidationPlanLine,
} from "@cubby/schemas/purchase-import";
import { sha256Hex } from "@cubby/shared/sha256";

/**
 * USD is the canonical unit for financial amounts. A Purchase can retain an
 * identified header whose source currency is unknown; unknown or foreign units
 * remain in original evidence and cannot authorize financial corrections.
 */
export const PURCHASE_CURRENCY = "USD";

export type LiveValidationLine = ValidationPlanLine & {
  /** Expense shortcode. */
  code: string;
  /** The live Expense row carries a Product link (even a tombstoned one). */
  explicitProduct: boolean;
};

export type LiveValidationState = {
  purchaseCode: string;
  orderId: string | null;
  statedTotal: number | null;
  lines: LiveValidationLine[];
};

export type ValidationComparison = {
  equal: boolean;
  corrections: ValidationCorrection[];
  notes: ValidationNote[];
};

type Target = ValidationCorrection["target"];

const purchaseTargetOf = (code: string): Target => ({
  kind: "purchase",
  code: shortcodeSchema("purchase").parse(code),
});
const expenseTargetOf = (code: string): Target => ({
  kind: "expense",
  code: shortcodeSchema("expense").parse(code),
});

const isExistingProduct = (value: string | null): value is string =>
  value !== null && shortcodeSchema("product").safeParse(value).success;

const byJson = (left: ValidationPlanLine, right: ValidationPlanLine) =>
  JSON.stringify(left).localeCompare(JSON.stringify(right));

const planOf = (line: ValidationPlanLine): ValidationPlanLine => ({
  title: line.title,
  amount: line.amount,
  lineKind: line.lineKind,
  quantity: line.quantity,
  productId: line.productId,
});

const liveSnapshot = (line: LiveValidationLine): ValidationPlanLine =>
  planOf(line);

const recordFingerprint = (line: LiveValidationLine) =>
  sha256Hex(
    JSON.stringify([
      "expense",
      line.code,
      line.title,
      line.amount,
      line.lineKind,
      line.quantity,
      line.productId,
      line.explicitProduct,
    ]),
  );

/**
 * Pair every expected line with at most one live Expense, deterministically:
 * exact match first, then title+amount, then title alone (nearest amount), then
 * amount+kind alone (a renamed line).
 * Identical duplicates consume one live row each, so a missing or surplus copy
 * is reported instead of masked.
 */
function pairLines(
  expected: readonly ValidationPlanLine[],
  live: readonly LiveValidationLine[],
) {
  const orderedExpected = [...expected].sort(byJson);
  const pool = [...live].sort(
    (a, b) =>
      a.title.localeCompare(b.title) ||
      a.amount - b.amount ||
      a.code.localeCompare(b.code),
  );
  const paired = new Map<ValidationPlanLine, LiveValidationLine>();
  const take = (
    line: ValidationPlanLine,
    matches: (candidate: LiveValidationLine) => boolean,
    rank: (candidate: LiveValidationLine) => number,
  ) => {
    let best: LiveValidationLine | undefined;
    for (const candidate of pool) {
      if (!matches(candidate)) continue;
      if (!best || rank(candidate) < rank(best)) best = candidate;
    }
    if (!best) return;
    pool.splice(pool.indexOf(best), 1);
    paired.set(line, best);
  };
  const passes: Array<
    [
      (line: ValidationPlanLine, c: LiveValidationLine) => boolean,
      (line: ValidationPlanLine, c: LiveValidationLine) => number,
    ]
  > = [
    [
      (line, c) =>
        c.title === line.title &&
        c.amount === line.amount &&
        c.lineKind === line.lineKind &&
        c.quantity === line.quantity &&
        c.productId === line.productId,
      () => 0,
    ],
    [(line, c) => c.title === line.title && c.amount === line.amount, () => 0],
    [
      (line, c) => c.title === line.title,
      (line, c) => Math.abs(c.amount - line.amount),
    ],
    // A renamed line: same money and kind, different words.
    [
      (line, c) => c.amount === line.amount && c.lineKind === line.lineKind,
      () => 0,
    ],
  ];
  for (const [matches, rank] of passes) {
    for (const line of orderedExpected) {
      if (paired.has(line)) continue;
      take(
        line,
        (c) => matches(line, c),
        (c) => rank(line, c),
      );
    }
  }
  return {
    pairs: orderedExpected.flatMap((line) => {
      const match = paired.get(line);
      return match ? [{ expected: line, live: match }] : [];
    }),
    missing: orderedExpected.filter((line) => !paired.has(line)),
    extra: pool,
  };
}

async function compareLine(
  expected: ValidationPlanLine,
  live: LiveValidationLine,
  out: { corrections: ValidationCorrection[]; notes: ValidationNote[] },
) {
  const target = expenseTargetOf(live.code);
  const fingerprint = await recordFingerprint(live);
  const correct = (
    field: "title" | "amount" | "quantity" | "lineKind" | "productId",
    before: ValidationCorrection["before"],
    after: ValidationCorrection["after"],
  ) =>
    out.corrections.push({
      id: `expense:${live.code}:${field}`,
      kind: "expense_field",
      target,
      field,
      before,
      after,
      fingerprint,
    });
  const note = (
    field: string,
    before: ValidationCorrection["before"],
    after: ValidationCorrection["after"],
    message: string,
  ) =>
    out.notes.push({
      id: `note:expense:${live.code}:${field}`,
      target,
      field,
      before,
      after,
      message,
    });

  if (expected.title !== live.title)
    correct("title", live.title, expected.title);
  if (expected.amount !== live.amount)
    correct("amount", live.amount, expected.amount);

  // An explicit Product assignment is never changed by validation.
  let productWillBeSet = live.explicitProduct;
  if (live.explicitProduct) {
    if (expected.productId !== live.productId)
      note(
        "productId",
        live.productId,
        expected.productId,
        "This line has an explicit Product assignment, which validation keeps. Change it on the Expense if the evidence is right.",
      );
  } else if (isExistingProduct(expected.productId)) {
    correct("productId", null, expected.productId);
    productWillBeSet = true;
  } else if (expected.productId !== null) {
    note(
      "productId",
      null,
      expected.productId,
      `The plan needs a Product that does not exist yet (${expected.productId}); resolve it through the import instead.`,
    );
  }

  if (expected.lineKind !== live.lineKind) {
    if (expected.lineKind !== "principal" && productWillBeSet)
      note(
        "lineKind",
        live.lineKind,
        expected.lineKind,
        "Only a principal line may keep a Product, so this change is left to the person.",
      );
    else correct("lineKind", live.lineKind, expected.lineKind);
  }
  if (expected.quantity !== live.quantity) {
    if (expected.quantity !== null && !productWillBeSet)
      note(
        "quantity",
        live.quantity,
        expected.quantity,
        "A quantity needs a linked Product, and this line has none to link.",
      );
    else correct("quantity", live.quantity, expected.quantity);
  }
}

/**
 * Compare the immutable evidence plan with a live Purchase and derive the typed,
 * field-level corrections a person may select. Pure over its inputs so
 * validation and apply derive the same result from the same state; a write
 * blocked plan (foreign currency, unreadable, sum mismatch) offers none.
 */
export async function compareValidationPlan(
  expected: ValidationExpectedPlan,
  live: LiveValidationState,
): Promise<ValidationComparison> {
  const out: Omit<ValidationComparison, "equal"> = {
    corrections: [],
    notes: [],
  };
  const purchaseTarget = purchaseTargetOf(live.purchaseCode);

  if (expected.writeBlockReason !== null) {
    out.notes.push({
      id: "note:plan:write_blocked",
      target: purchaseTarget,
      field: "plan",
      before: null,
      after: expected.writeBlockReason,
      message: `The evidence plan cannot be written (${expected.writeBlockReason}), so no corrections are offered.`,
    });
    return { equal: false, ...out };
  }
  if (expected.currency !== PURCHASE_CURRENCY)
    out.notes.push({
      id: "note:plan:currency",
      target: purchaseTarget,
      field: "currency",
      before: PURCHASE_CURRENCY,
      after: expected.currency,
      message: "The plan currency differs from the Purchase currency.",
    });
  if (expected.orderId !== live.orderId)
    out.notes.push({
      id: "note:purchase:orderId",
      target: purchaseTarget,
      field: "orderId",
      before: live.orderId,
      after: expected.orderId,
      message:
        "The order id identifies the Purchase and is never changed by validation.",
    });
  if (expected.statedTotal !== live.statedTotal) {
    out.corrections.push({
      id: "purchase:statedTotal",
      kind: "purchase_stated_total",
      target: purchaseTarget,
      field: "statedTotal",
      before: live.statedTotal,
      after: expected.statedTotal,
      fingerprint: await sha256Hex(
        JSON.stringify([
          "purchase",
          live.purchaseCode,
          live.orderId,
          live.statedTotal,
        ]),
      ),
    });
  }

  const { pairs, missing, extra } = pairLines(expected.lines, live.lines);
  for (const pair of pairs) await compareLine(pair.expected, pair.live, out);

  const lineSetFingerprint = await sha256Hex(
    JSON.stringify([
      "lines",
      live.purchaseCode,
      [...live.lines]
        .sort((a, b) => a.code.localeCompare(b.code))
        .map((line) => [line.code, liveSnapshot(line), line.explicitProduct]),
    ]),
  );
  const occurrences = new Map<string, number>();
  for (const line of missing) {
    const digest = (await sha256Hex(JSON.stringify(planOf(line)))).slice(0, 12);
    const occurrence = occurrences.get(digest) ?? 0;
    occurrences.set(digest, occurrence + 1);
    const addable =
      (line.productId === null || isExistingProduct(line.productId)) &&
      (line.quantity === null || line.productId !== null);
    if (addable)
      out.corrections.push({
        id: `line:add:${digest}:${occurrence}`,
        kind: "expense_add",
        target: purchaseTarget,
        field: "line",
        before: null,
        after: planOf(line),
        fingerprint: lineSetFingerprint,
      });
    else
      out.notes.push({
        id: `note:line:add:${digest}:${occurrence}`,
        target: purchaseTarget,
        field: "line",
        before: null,
        after: planOf(line),
        message:
          "The plan has a line with no live Expense, but it needs a Product that is not resolved. Resolve it through the import.",
      });
  }
  for (const line of extra)
    out.corrections.push({
      id: `expense:${line.code}:remove`,
      kind: "expense_remove",
      target: expenseTargetOf(line.code),
      field: "line",
      before: liveSnapshot(line),
      after: null,
      fingerprint: await recordFingerprint(line),
    });

  return {
    equal: out.corrections.length === 0 && out.notes.length === 0,
    ...out,
  };
}
