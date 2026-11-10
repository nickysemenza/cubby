/** Suggestion families that declare an Automatic rule; connections have none. */
export const AUTOMATIC_RULE_FAMILIES = [
  "field",
  "statement_transaction",
] as const;
/** Each key leads with its family. The rules are code declarations with no switch. */
export const AUTOMATIC_RULE_KEYS = [
  "field.addition",
  "statement_transaction.book_spending",
] as const;

/** Field policy receipt revision; bump it when the field gate changes. */
export const FIELD_ASSIGNMENT_REVISION = "2026-11-09.1";

export type AutomaticRuleFamily = (typeof AUTOMATIC_RULE_FAMILIES)[number];
export type AutomaticRuleKey = (typeof AUTOMATIC_RULE_KEYS)[number];
