import { z } from "zod";

export const expenseLineKindValues = [
  "principal",
  "tax",
  "shipping",
  "discount",
  "fee",
  "tip",
  "other_adjustment",
] as const;

export const expenseLineKindSchema = z.enum(expenseLineKindValues);
export type ExpenseLineKind = z.infer<typeof expenseLineKindSchema>;

/**
 * Whether an Expense row is a line item or a slice of an un-itemized total.
 *
 * `lineKind` answers "what role does this play on the receipt"; `lineBasis`
 * answers "does this row correspond to something you can point at". They are
 * orthogonal: an `allocation` is still `principal` money.
 *
 * `allocation` covers the two ways a lump sum gets cut into ledger rows without
 * ever being itemized:
 *   - by payment schedule — a deposit and a balance on one vendor order, where
 *     the deposit is money on account and buys no particular item; and
 *   - by an estimated materials/labor split of a single non-itemized contract,
 *     where `costType` on the row is a guess rather than a vendor-stated fact.
 *
 * Consequences worth knowing before you read one of these rows:
 *   - it can never carry a `productId` (the money doesn't decompose per item),
 *     so it is correctly absent from every "goods without a product" worklist;
 *   - its `costType` may be an estimate, so materials-vs-services breakdowns
 *     mix guesses with facts wherever allocations are included.
 *
 * Deliberately NOT inferred from the name. "1/2" matches `1/2 in. conduit` far
 * more often than an installment half, and the population is small enough to
 * set by hand — see the `purchase-import` skill's checklist.
 */
export const expenseLineBasisValues = ["item_line", "allocation"] as const;

export const expenseLineBasisSchema = z.enum(expenseLineBasisValues);
export type ExpenseLineBasis = z.infer<typeof expenseLineBasisSchema>;

export const isPrincipalExpense = (expense: {
  lineKind: ExpenseLineKind;
}): boolean => expense.lineKind === "principal";

export type ExpenseLineKindInspection = {
  lineKind: ExpenseLineKind;
  /** Loose name hints are surfaced to backfills for review, never auto-applied. */
  hintedKinds: Exclude<ExpenseLineKind, "principal" | "other_adjustment">[];
  confidence: "high" | "ambiguous" | "none";
};

type HintedExpenseLineKind = Exclude<
  ExpenseLineKind,
  "principal" | "other_adjustment"
>;

const LINE_KIND_MARKERS = [
  { kind: "tax", pattern: /\b(?:sales tax|estimated tax|tax)\b/ },
  { kind: "shipping", pattern: /\b(?:shipping|delivery|freight)\b/ },
  { kind: "discount", pattern: /\b(?:discount|coupon)\b/ },
  { kind: "fee", pattern: /\b(?:fee|processing|assessment)\b/ },
  { kind: "tip", pattern: /\b(?:tip|gratuity)\b/ },
] satisfies readonly { kind: HintedExpenseLineKind; pattern: RegExp }[];

const EXACT_LINE_KIND_PATTERNS = [
  {
    kind: "shipping",
    pattern:
      /^(?:shipping(?: and handling)?|delivery(?: charge)?|freight(?: charge)?|liftgate shipping|ups ground shipping)$/,
  },
  {
    kind: "discount",
    pattern:
      /^(?:discount|coupon(?: discount)?|(?:order|shipping|volume|promotional) discount)$/,
  },
  {
    kind: "fee",
    pattern:
      /^(?:fee|(?:handling|processing|service|delivery) (?:charge|fee))$/,
  },
  { kind: "tip", pattern: /^(?:tip|gratuity)$/ },
] satisfies readonly { kind: HintedExpenseLineKind; pattern: RegExp }[];

const classifyExactLineKind = (head: string): ExpenseLineKind => {
  const isTax =
    head === "tax" ||
    head === "sales tax" ||
    head === "estimated tax" ||
    /^(?:[\p{L}\p{N}&.'-]+\s+){1,4}sales tax$/u.test(head);
  if (isTax) return "tax";
  return (
    EXACT_LINE_KIND_PATTERNS.find(({ pattern }) => pattern.test(head))?.kind ??
    "principal"
  );
};

const hintedLineKinds = (normalized: string): HintedExpenseLineKind[] =>
  LINE_KIND_MARKERS.filter(({ pattern }) => pattern.test(normalized)).map(
    ({ kind }) => kind,
  );

/**
 * Infer a receipt role only when the Expense name itself is unambiguous.
 * Product identity, notes, totals, and tax-rate arithmetic are deliberately
 * outside this classifier: a principal line may already be tax-inclusive.
 */
export function inspectExpenseLineKind(input: {
  name: string;
  productId?: string | null;
}): ExpenseLineKindInspection {
  if (input.productId) {
    return { lineKind: "principal", hintedKinds: [], confidence: "none" };
  }

  // Split on one whitespace code point at a time instead of using a repeated
  // whitespace regexp. Besides keeping normalization linear for untrusted
  // names, this still collapses every run to the single separator below.
  const normalized = input.name
    .trim()
    .toLocaleLowerCase("en-US")
    .split(/\s/u)
    .filter(Boolean)
    .join(" ");
  const head = normalized.split(/ [—–] /u, 1)[0]?.trim() ?? normalized;

  const hintedKinds = hintedLineKinds(normalized);

  const explicitlyCombined =
    /^(?:sales tax|estimated tax|tax|shipping|delivery|freight|discount|fee|tip)\b.*(?:,|\s(?:and|&|\+|\/)\s)/.test(
      normalized,
    );
  if (
    hintedKinds.length > 1 &&
    (/\border\b/.test(normalized) ||
      /\bcharge\b/.test(normalized) ||
      explicitlyCombined)
  ) {
    return {
      lineKind: "other_adjustment",
      hintedKinds,
      confidence: "high",
    };
  }

  const lineKind = classifyExactLineKind(head);

  return {
    lineKind,
    hintedKinds,
    confidence:
      lineKind !== "principal"
        ? "high"
        : hintedKinds.length > 0
          ? "ambiguous"
          : "none",
  };
}

export function inferExpenseLineKind(input: {
  name: string;
  productId?: string | null;
}): ExpenseLineKind {
  return inspectExpenseLineKind(input).lineKind;
}

/** Resolve a draft's optional auto-detection exactly as the persisted write does. */
export function resolveExpenseLineKind(input: {
  lineKind?: string | null;
  name?: string | null;
  productId?: string | null;
}): ExpenseLineKind {
  return input.lineKind == null || input.lineKind === "auto"
    ? inferExpenseLineKind({
        name: input.name ?? "",
        productId: input.productId,
      })
    : expenseLineKindSchema.parse(input.lineKind);
}
