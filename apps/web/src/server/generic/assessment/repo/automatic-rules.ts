import { HIGH_CONFIDENCE_PROBABILITY } from "@cubby/schemas/ai-evaluation";
import {
  FIELD_ASSIGNMENT_REVISION,
  AUTOMATIC_RULE_KEYS,
  type AutomaticRuleFamily,
  type AutomaticRuleKey,
} from "@cubby/schemas/automatic-rule";
import { entityFieldByKey } from "@cubby/schemas/entity-fields";
import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";
import { requiresSuggestionReview } from "@cubby/schemas/field-suggestion-policy";
import type { StatementTransactionJudgment } from "@cubby/schemas/statement-suggestion";
import { cents } from "@cubby/shared";

import { STATEMENT_CHARGE_IDENTITY_FEATURE } from "~/server/ai/policy/features";
import { STATEMENT_SUGGESTION_REVISION } from "~/server/domains/transaction-import/repo/statement-suggestions";

/** What a field rule reads from the published proposal. */
export type FieldRuleFacts = {
  entity: ShortcodeEntity;
  field: string;
  kind: string;
  confidence: number;
  model: string;
};

type FactsOf = {
  field: FieldRuleFacts;
  statement_transaction: StatementTransactionJudgment;
};

/** What an automatic application does, before the family's review input. */
type RuleApplication =
  | { kind: "accept_as_is" }
  /** Attach to this candidate (internal id); no diff field is ever ticked. */
  | { kind: "statement_attach"; transactionId: string };

type FamilyOf<K extends AutomaticRuleKey> =
  K extends `${infer F extends AutomaticRuleFamily}.${string}` ? F : never;

type Declaration<F extends AutomaticRuleFamily> = {
  family: F;
  description: string;
  /** Read at call time: the statement revision lives in a module that imports this one. */
  revision: () => string;
  /** `member_switch` applies only while a member has it on for this revision. */
  execution: "member_switch" | "import_clean" | "field_policy";
  match: (facts: FactsOf[F]) => boolean;
  application: (facts: FactsOf[F]) => RuleApplication;
};

const soleCandidate = (judgment: StatementTransactionJudgment) =>
  judgment.candidates.length === 1 ? judgment.candidates[0] : undefined;

/**
 * Automatic rules, keyed by `<family>.<name>`. Each reads its family's
 * published evidence directly and deterministically; model confidence is part
 * of a definition but never authorizes one alone. Field application also checks
 * live emptiness, evidence, winner margin and member intent. Connections have none.
 */
export const AUTOMATIC_RULES = {
  "field.addition": {
    execution: "field_policy",
    family: "field",
    description:
      "Fill an empty declared assignment field at high confidence with current evidence and a clear winner, preserving member decisions.",
    revision: () => FIELD_ASSIGNMENT_REVISION,
    match: (facts) =>
      facts.kind === "addition" &&
      entityFieldByKey(facts.entity, facts.field)?.control?.suggest?.mode ===
        "fill" &&
      !requiresSuggestionReview(facts.entity, facts.field) &&
      facts.confidence >= HIGH_CONFIDENCE_PROBABILITY,
    application: () => ({ kind: "accept_as_is" }),
  },
  "statement_transaction.attach": {
    execution: "member_switch",
    family: "statement_transaction",
    description:
      "Attach a charge to its only candidate when no sibling could be the same money, no other charge already settles that candidate, the amounts match to the cent, and the decision model labels it the same charge with high confidence.",
    revision: () =>
      `${STATEMENT_SUGGESTION_REVISION}/${STATEMENT_CHARGE_IDENTITY_FEATURE.promptVersion}`,
    match: (judgment) => {
      const only = soleCandidate(judgment);
      return Boolean(
        !judgment.reviewReason &&
        judgment.recommended === "attach" &&
        (!(
          judgment.create &&
          ["purchase", "refund", "fee"].includes(judgment.create.kind)
        ) ||
          judgment.clean) &&
        judgment.siblings.length === 0 &&
        only &&
        !only.claimed &&
        judgment.create &&
        cents(only.amount) === cents(judgment.create.amount) &&
        only.label?.same === "same" &&
        only.label.confidence === "high" &&
        only.label.model,
      );
    },
    application: (judgment) => ({
      kind: "statement_attach",
      transactionId: soleCandidate(judgment)!.transactionId,
    }),
  },
  "statement_transaction.book_spending": {
    family: "statement_transaction",
    execution: "import_clean",
    description:
      "Book clean supported spending from imports automatically by default. Pause to leave future clean spending suggestions pending for review.",
    revision: () => STATEMENT_SUGGESTION_REVISION,
    match: (judgment) =>
      !judgment.reviewReason &&
      judgment.clean &&
      judgment.spending?.status === "ready",
    application: () => ({ kind: "accept_as_is" }),
  },
} satisfies { [K in AutomaticRuleKey]: Declaration<FamilyOf<K>> };

export type AutomaticRuleMatch = {
  key: AutomaticRuleKey;
  revision: string;
  stamp: string;
  application: RuleApplication;
};

/** `<ruleKey>@<revision>`: the stamp a publication and receipt carry. */
export const ruleBase = (key: AutomaticRuleKey) =>
  `${key}@${AUTOMATIC_RULES[key].revision()}`;

/** Unscoped statement sweeps cannot execute these current-revision rules. */
export const importOnlyStatementRuleStamps = () =>
  AUTOMATIC_RULE_KEYS.filter(
    (key) =>
      AUTOMATIC_RULES[key].family === "statement_transaction" &&
      AUTOMATIC_RULES[key].execution === "import_clean",
  ).map(ruleBase);

function evaluate<F extends AutomaticRuleFamily>(
  key: AutomaticRuleKey,
  rule: Declaration<F>,
  facts: FactsOf[F],
): AutomaticRuleMatch[] {
  if (!rule.match(facts)) return [];
  return [
    {
      key,
      revision: rule.revision(),
      stamp: ruleBase(key),
      application: rule.application(facts),
    },
  ];
}

/** The field rules a published proposal matches now. */
export const matchFieldRules = (facts: FieldRuleFacts) =>
  evaluate("field.addition", AUTOMATIC_RULES["field.addition"], facts);

/** The statement rules a published judgment matches now. */
export const matchStatementRules = (judgment: StatementTransactionJudgment) => [
  ...evaluate(
    "statement_transaction.attach",
    AUTOMATIC_RULES["statement_transaction.attach"],
    judgment,
  ),
  ...evaluate(
    "statement_transaction.book_spending",
    AUTOMATIC_RULES["statement_transaction.book_spending"],
    judgment,
  ),
];

/**
 * The publication stamp a statement suggestion carries in `data`: the rules it
 * matched when published, so a judgment from an older revision never applies.
 */
export const automaticRuleStamp = (
  matches: readonly AutomaticRuleMatch[],
): { matchedRules?: string[] } =>
  matches.length ? { matchedRules: matches.map((match) => match.stamp) } : {};
