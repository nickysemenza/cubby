import type {
  AutomaticRuleFamily,
  AutomaticRuleKey,
} from "@cubby/schemas/automatic-rule";
import type { StatementTransactionJudgment } from "@cubby/schemas/statement-suggestion";

import { STATEMENT_SUGGESTION_REVISION } from "~/server/domains/transaction-import/repo/statement-suggestion-revision";

type FactsOf = {
  statement_transaction: StatementTransactionJudgment;
};

/**
 * Clean kinds that settle without spending. A supported opposite leg is
 * booked through the transfer-pair owner.
 */
const SETTLEMENT_ONLY_KINDS: readonly string[] = [
  "income",
  "account_transfer",
  "credit_card_payment",
  "interest",
  "adjustment",
];

/** What an automatic application does, before the family's review input. */
type RuleApplication = { kind: "accept_as_is" };

type FamilyOf<K extends AutomaticRuleKey> =
  K extends `${infer F extends AutomaticRuleFamily}.${string}` ? F : never;

type Declaration<F extends AutomaticRuleFamily> = {
  family: F;
  description: string;
  /** Read at call time: the statement revision lives in a module that imports this one. */
  revision: () => string;
  execution: "statement_settlement";
  match: (facts: FactsOf[F]) => boolean;
  application: (facts: FactsOf[F]) => RuleApplication;
};

/**
 * Automatic rules, keyed by `<family>.<name>`. Each reads its family's
 * published evidence directly and deterministically; model confidence is part
 * of a definition but never authorizes one alone. Field values are the `fields`
 * reconciler's, not a rule's. Connections have none.
 */
export const AUTOMATIC_RULES = {
  "statement_transaction.book_spending": {
    family: "statement_transaction",
    execution: "statement_settlement",
    description:
      "Book clean supported spending and non-spending statement transactions, and attach supported evidence to an existing Transaction.",
    revision: () => STATEMENT_SUGGESTION_REVISION,
    match: (judgment) =>
      judgment.recommended === "attach"
        ? !judgment.reviewReason &&
          judgment.clean &&
          (judgment.pairedTransactionId !== null ||
            (judgment.create !== null &&
              SETTLEMENT_ONLY_KINDS.includes(judgment.create.kind) &&
              judgment.spending?.status === "deferred"))
        : !judgment.reviewReason &&
          judgment.clean &&
          (judgment.spending?.status === "ready" ||
            (judgment.recommended === "create" &&
              judgment.create !== null &&
              SETTLEMENT_ONLY_KINDS.includes(judgment.create.kind))),
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

/** The statement rules a published judgment matches now. */
export const matchStatementRules = (judgment: StatementTransactionJudgment) => [
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
