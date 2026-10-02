import type { Entity } from "@cubby/schemas/entity";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import type { FieldExplanationOutput } from "@cubby/schemas/field-explanation";
import {
  spendingCategorySummaryLabels,
  spendingCategorySummarySchema,
} from "@cubby/schemas/spending-classification";
import { z } from "zod";

type ExplainedField = (typeof entityFieldModels)[Entity]["fields"][number];
import { formatCurrency } from "~/lib/utils";

function resultLabel(
  field: ExplainedField,
  value: z.infer<ReturnType<typeof z.json>>,
): string {
  const text = z.string().safeParse(value);
  if (text.success) {
    const options = field.display.valueOptions ?? field.control?.options ?? [];
    return (
      options.find((option) => option.value === text.data)?.label ??
      (/^[a-z]+(?:_[a-z]+)+$/.test(text.data)
        ? text.data
            .replaceAll("_", " ")
            .replace(/^./, (letter) => letter.toUpperCase())
        : text.data)
    );
  }
  const number = z.number().safeParse(value);
  if (number.success)
    return field.display.format === "currency" ||
      field.display.format === "signedCurrency"
      ? formatCurrency(number.data)
      : String(number.data);
  const boolean = z.boolean().safeParse(value);
  if (boolean.success) return boolean.data ? "Yes" : "No";
  return value === null ? "No value determined" : field.label;
}

type Interpretation = NonNullable<FieldExplanationOutput["interpretation"]>;
type InterpretationCopy = Pick<
  Interpretation,
  "summary" | "caveats" | "nextSteps"
>;

// State-specific interpretation stays beside the shared resolver, independent of client chrome.
const itemizationInterpretations = {
  bare: {
    summary:
      "No purchase is linked to this charge, so there are no purchase expense lines to compare.",
    caveats: ["A missing link does not establish that no purchase occurred."],
    nextSteps: [
      "Review the transaction and confirm its purchase allocation if one is available.",
    ],
  },
  lump: {
    summary:
      "The linked purchase has no product-linked expense lines for an itemized comparison.",
    caveats: [
      "A purchase can be linked and settled while its individual items remain unrecorded.",
    ],
    nextSteps: [
      "Open the linked purchase and review or add its expense lines.",
    ],
  },
  itemized_match: {
    summary:
      "The linked purchase has product-linked expense lines whose total matches this charge under the itemization rule.",
    caveats: [
      "A matching total does not verify product identity, category coverage, or supporting documents.",
    ],
    nextSteps: [
      "Open the linked purchase to review its item details and evidence.",
    ],
  },
  itemized_mismatch: {
    summary:
      "The linked purchase has product-linked expense lines, but their total differs from this charge.",
    caveats: [
      "The difference may require reviewing refunds, adjustments, or incomplete item prices; it is not automatically corrected.",
    ],
    nextSteps: [
      "Review the linked purchase's expense lines and the confirmed settlement amount.",
    ],
  },
  shared: {
    summary:
      "More than one live charge settles the linked purchase. This charge is not compared independently against all of that purchase's items.",
    caveats: ["Shared settlement is distinct from an itemization mismatch."],
    nextSteps: [
      "Open the purchase and review all of its confirmed settlement allocations together.",
    ],
  },
} satisfies Record<string, InterpretationCopy>;

function declaredInterpretation(
  field: ExplainedField,
  value: z.infer<ReturnType<typeof z.json>>,
): InterpretationCopy | null {
  if (field.explanation?.ruleId !== "financial-transaction.itemization")
    return null;
  const state = z
    .enum(["bare", "lump", "itemized_match", "itemized_mismatch", "shared"])
    .safeParse(value);
  return state.success ? itemizationInterpretations[state.data] : null;
}

/** Use declared display semantics; never infer currency or a score from a number. */
export function interpretFieldValue(
  field: ExplainedField,
  value: z.infer<ReturnType<typeof z.json>>,
): NonNullable<FieldExplanationOutput["interpretation"]> {
  const result = resultLabel(field, value);
  const interpretation: NonNullable<FieldExplanationOutput["interpretation"]> =
    {
      result,
      summary: field.explanation?.description ?? field.description ?? "",
      caveats: [
        "This reflects recorded inputs at evaluation time. Unrecorded or unavailable source evidence cannot be inferred.",
      ],
      nextSteps: [
        "Open this record or a linked evidence record to review the inputs used by this rule.",
      ],
    };
  const declared = declaredInterpretation(field, value);
  if (declared) return { result, ...declared };
  if (field.key.endsWith("Count")) {
    const count = z.number().safeParse(value);
    if (count.success)
      interpretation.summary = `The current count is ${count.data}. ${interpretation.summary}`;
  }
  if (field.key === "spendingCategorySummary") {
    const summary = spendingCategorySummarySchema.parse(value);
    interpretation.result = spendingCategorySummaryLabels[summary.state];
    interpretation.summary =
      summary.state === "not_applicable"
        ? "Expense categorization does not apply to this record."
        : summary.lineCount === 0
          ? "No linked expense lines provide category evidence."
          : `${summary.categorizedLineCount} of ${summary.lineCount} linked expense lines are classified${summary.categories.length ? ` across ${summary.categories.map((category) => category.name).join(", ")}` : ""}. ${summary.uncategorizedLineCount ? `${summary.uncategorizedLineCount} lines still need a category.` : "Every linked line has a category."}`;
    if (!summary.amountsKnown)
      interpretation.caveats.push(
        "Some category amounts are unknown. Complete category coverage does not establish complete monetary coverage.",
      );
    if (field.explanation?.ruleId.startsWith("financialTransaction."))
      interpretation.caveats.push(
        "Categories describe linked Expense lines. Settlement allocations do not attribute this transaction amount to individual categories.",
      );
    if (summary.uncategorizedLineCount > 0)
      interpretation.nextSteps.push(
        "Open the linked expense lines and classify the remaining lines.",
      );
  } else if (Array.isArray(value)) {
    interpretation.result = `${value.length} ${value.length === 1 ? "entry" : "entries"}`;
  } else if (value === null) {
    interpretation.caveats.push(
      "No value was determined from the current inputs; this is not a numeric zero.",
    );
  }
  return interpretation;
}
