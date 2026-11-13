/** Suggestion families that declare an Automatic rule; connections have none. */
export const AUTOMATIC_RULE_FAMILIES = ["statement_transaction"] as const;
/** Each key leads with its family. The rules are code declarations with no switch. */
const AUTOMATIC_RULE_KEYS = ["statement_transaction.book_spending"] as const;

export type AutomaticRuleFamily = (typeof AUTOMATIC_RULE_FAMILIES)[number];
export type AutomaticRuleKey = (typeof AUTOMATIC_RULE_KEYS)[number];
