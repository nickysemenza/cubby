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

/** The bar a rule's member-reviewed matches must clear (ADR 0016 amendment). */
export const AUTOMATIC_RULE_MIN_REVIEWS = 50;
export const AUTOMATIC_RULE_MIN_PRECISION = 0.98;
export const AUTOMATIC_RULE_WINDOW = 200;
/** One match in this many is held for review. */
export const AUTOMATIC_RULE_AUDIT_EVERY = 20;

const count = z.number().int().nonnegative();

/**
 * One precision window: the latest member-reviewed matches of one stamp that
 * were served for review. Automatic applications later marked Wrong are
 * counted apart and never enter the ratio.
 */
export const automaticRuleWindow = z.object({
  /** `<ruleKey>@<revision>`, then `@<model>` for a rule measured per decision model. */
  stamp: z.string(),
  model: z.string().nullable(),
  n: count,
  hits: count,
  precision: z.number().nullable(),
  eligible: z.boolean(),
  correctedAutomatic: count,
});
export type AutomaticRuleWindow = z.infer<typeof automaticRuleWindow>;

export const automaticRuleOut = z.object({
  family: automaticRuleFamily,
  ruleKey: automaticRuleKey,
  /** The revision the code declares now; a bump starts new windows. */
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
  /** Some window clears the bar, so a member may turn the rule on. */
  eligible: z.boolean(),
  /** Sums over the declared revision's windows. */
  n: count,
  hits: count,
  precision: z.number().nullable(),
  correctedAutomatic: count,
  windows: z.array(automaticRuleWindow),
});
export type AutomaticRuleOut = z.infer<typeof automaticRuleOut>;

export const automaticRulesOut = z.object({
  rules: z.array(automaticRuleOut),
});
export type AutomaticRulesOut = z.infer<typeof automaticRulesOut>;

/** Turning a rule on requires eligibility; turning it off is always allowed. */
export const setAutomaticRuleInput = z.object({
  ruleKey: automaticRuleKey,
  enabled: z.boolean(),
});
