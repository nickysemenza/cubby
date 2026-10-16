import {
  expenseLineKindValues,
  EXPENSE_LINE_ROLE_RULES,
} from "@cubby/schemas/expense-line-kind";
import type { ExtractedPurchaseLine } from "@cubby/schemas/purchase-import";

import type { DecisionChoicePrompt } from "~/server/ai/policy/decision-choice";

export const PRODUCT_IDENTITY_RULES =
  "Choose an existing product only when the title, model, size, count, and variant identify the same sellable item. Choose none for a distinct or uncertain variant.";

const lineDecisionSubject = (line: ExtractedPurchaseLine) =>
  JSON.stringify({
    title: line.title,
    amount: line.amount,
    extractedLineKind: line.lineKind,
    quantity: line.quantity ?? null,
    sku: line.sku ?? null,
    seller: line.seller ?? null,
    productUrl: line.productUrl ?? null,
  });

export const expenseLineRoleRules = EXPENSE_LINE_ROLE_RULES;

export const purchaseLinePrompts = {
  role: {
    choices: expenseLineKindValues.filter((value) => value !== "unclassified"),
    rules: expenseLineRoleRules,
  },
  kit: {
    choices: ["kit_with_components", "single", "n_pack"] as const,
    rules:
      "Classify the sellable item. A kit has distinct reusable components, an n-pack is repeated units of one item, and a single is one sellable product.",
  },
  promotion: {
    choices: ["promote", "coarse_only"] as const,
    rules:
      "Choose promote only when the line identifies a durable sellable product worth creating or linking. Choose coarse_only for services, vague bundles, fees, warranties, or insufficient identity.",
  },
  reversal: {
    choices: ["return", "concession", "cancellation", "replacement"] as const,
    rules:
      "Classify a negative item row: return means units left the household; concession means the item was kept; cancellation means it was never acquired; replacement means the money line accompanies a replacement rather than a returned unit.",
  },
} as const;

export function purchaseLinePrompt(
  stage: keyof typeof purchaseLinePrompts,
  line: ExtractedPurchaseLine,
): DecisionChoicePrompt {
  const spec = purchaseLinePrompts[stage];
  return {
    subject: lineDecisionSubject(line),
    rules: spec.rules,
    choices: spec.choices,
    allowNone: stage === "role",
  };
}
