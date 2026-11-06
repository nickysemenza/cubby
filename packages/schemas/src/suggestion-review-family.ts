import type { SuggestionFamily } from "./suggestion";

export const suggestionReviewFamilies = {
  field: { kind: "proposal", label: "Fields" },
  email_relevance: { kind: "automatic_decision", label: "Email relevance" },
  email_link: { kind: "automatic_decision", label: "Email links" },
  mail_import_outcome: {
    kind: "automatic_decision",
    label: "Mail import outcomes",
  },
  product_pair: { kind: "proposal", label: "Product pairs" },
  recommendation: {
    kind: "proposal",
    label: "Connections and recommendations",
  },
  statement_transaction: { kind: "proposal", label: "Statements" },
  transfer_pair: { kind: "proposal", label: "Transfer pairs" },
} as const satisfies Record<
  SuggestionFamily,
  { kind: "proposal" | "automatic_decision"; label: string }
>;
