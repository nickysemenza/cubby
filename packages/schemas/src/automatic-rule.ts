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
export const FIELD_ASSIGNMENT_REVISION = "2026-10-20.1";

export const automaticRuleFamily = z.enum(AUTOMATIC_RULE_FAMILIES);
export type AutomaticRuleFamily = z.infer<typeof automaticRuleFamily>;
export const automaticRuleKey = z.enum(AUTOMATIC_RULE_KEYS);
export type AutomaticRuleKey = z.infer<typeof automaticRuleKey>;

export const automaticRuleOut = z.object({
  family: automaticRuleFamily,
  ruleKey: automaticRuleKey,
  /** The revision the code declares now; a bump turns a member switch off. */
  revision: z.string(),
  description: z.string(),
  /** On for the declared revision. */
  enabled: z.boolean(),
  /** The revision the stored switch was last set for. */
  enabledRevision: z.string(),
  enabledAt: z.iso.datetime().nullable(),
  /** Null when a migration, not a member, turned it on. */
  enabledByUserId: z.string().nullable(),
  enabledReason: z.string().nullable(),
  disabledAt: z.iso.datetime().nullable(),
  disabledReason: z.string().nullable(),
});
export type AutomaticRuleOut = z.infer<typeof automaticRuleOut>;

export const automaticRulesOut = z.object({
  rules: z.array(automaticRuleOut),
});
export type AutomaticRulesOut = z.infer<typeof automaticRulesOut>;

/** A member turns a rule on or off for the declared revision. */
export const setAutomaticRuleInput = z.object({
  ruleKey: automaticRuleKey,
  enabled: z.boolean(),
});
