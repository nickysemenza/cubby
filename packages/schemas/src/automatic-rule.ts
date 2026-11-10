import { z } from "zod";

/** Suggestion families that declare an Automatic rule; connections have none. */
export const AUTOMATIC_RULE_FAMILIES = [
  "field",
  "statement_transaction",
] as const;
/** Each key leads with its family. Adding one widens the storage CHECK. */
export const AUTOMATIC_RULE_KEYS = [
  "field.addition",
  "statement_transaction.attach",
  "statement_transaction.book_spending",
] as const;

/** Field policy receipt revision; the field rule is no longer a measured switch. */
export const FIELD_ASSIGNMENT_REVISION = "2026-10-24.1";

const automaticRuleFamily = z.enum(AUTOMATIC_RULE_FAMILIES);
export type AutomaticRuleFamily = z.infer<typeof automaticRuleFamily>;
const automaticRuleKey = z.enum(AUTOMATIC_RULE_KEYS);
export type AutomaticRuleKey = z.infer<typeof automaticRuleKey>;
