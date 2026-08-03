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

export const isPrincipalExpense = (expense: {
  lineKind: ExpenseLineKind;
}): boolean => expense.lineKind === "principal";

export type ExpenseLineKindInspection = {
  lineKind: ExpenseLineKind;
  /** Loose name hints are surfaced to backfills for review, never auto-applied. */
  hintedKinds: Exclude<ExpenseLineKind, "principal" | "other_adjustment">[];
  confidence: "high" | "ambiguous" | "none";
};

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

  const markers = new Set<Exclude<ExpenseLineKind, "principal">>();
  if (/\b(?:sales tax|estimated tax|tax)\b/.test(normalized))
    markers.add("tax");
  if (/\b(?:shipping|delivery|freight)\b/.test(normalized))
    markers.add("shipping");
  if (/\b(?:discount|coupon)\b/.test(normalized)) markers.add("discount");
  if (/\b(?:fee|processing|assessment)\b/.test(normalized)) markers.add("fee");
  if (/\b(?:tip|gratuity)\b/.test(normalized)) markers.add("tip");

  // A name that explicitly combines receipt-footer components is an
  // adjustment, but assigning the whole amount to any one component would be
  // false precision. Requiring order/charge language or an explicit connector
  // after a recognized adjustment prefix avoids treating product titles such
  // as "Shipping tape after discount" as combined adjustments.
  const explicitlyCombined =
    /^(?:sales tax|estimated tax|tax|shipping|delivery|freight|discount|fee|tip)\b.*(?:,|\s(?:and|&|\+|\/)\s)/.test(
      normalized,
    );
  if (
    markers.size > 1 &&
    (/\border\b/.test(normalized) ||
      /\bcharge\b/.test(normalized) ||
      explicitlyCombined)
  ) {
    return {
      lineKind: "other_adjustment",
      hintedKinds: [...markers].filter(
        (
          kind,
        ): kind is Exclude<ExpenseLineKind, "principal" | "other_adjustment"> =>
          kind !== "other_adjustment",
      ),
      confidence: "high",
    };
  }

  let lineKind: ExpenseLineKind = "principal";
  if (
    head === "tax" ||
    head === "sales tax" ||
    head === "estimated tax" ||
    /^(?:[\p{L}\p{N}&.'-]+\s+){1,4}sales tax$/u.test(head)
  ) {
    lineKind = "tax";
  }

  if (
    lineKind === "principal" &&
    /^(?:shipping(?: and handling)?|delivery(?: charge)?|freight(?: charge)?|liftgate shipping|ups ground shipping)$/.test(
      head,
    )
  ) {
    lineKind = "shipping";
  }

  if (
    lineKind === "principal" &&
    /^(?:discount|coupon(?: discount)?|(?:order|shipping|volume|promotional) discount)$/.test(
      head,
    )
  ) {
    lineKind = "discount";
  }

  if (
    lineKind === "principal" &&
    /^(?:fee|(?:handling|processing|service|delivery) (?:charge|fee))$/.test(
      head,
    )
  ) {
    lineKind = "fee";
  }

  if (lineKind === "principal" && /^(?:tip|gratuity)$/.test(head)) {
    lineKind = "tip";
  }

  return {
    lineKind,
    hintedKinds: [...markers].filter(
      (
        kind,
      ): kind is Exclude<ExpenseLineKind, "principal" | "other_adjustment"> =>
        kind !== "other_adjustment",
    ),
    confidence:
      lineKind !== "principal"
        ? "high"
        : markers.size > 0
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
