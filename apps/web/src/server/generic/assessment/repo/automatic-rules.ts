import { SUGGESTION_AUTO_APPLY_THRESHOLD } from "@cubby/schemas/ai-evaluation";
import {
  AUTOMATIC_RULE_AUDIT_EVERY,
  FIELD_ASSIGNMENT_REVISION,
  type AutomaticRuleFamily,
  type AutomaticRuleKey,
} from "@cubby/schemas/automatic-rule";
import { entityFieldByKey } from "@cubby/schemas/entity-fields";
import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";
import { requiresSuggestionReview } from "@cubby/schemas/field-suggestion";
import type { StatementTransactionJudgment } from "@cubby/schemas/statement-suggestion";
import { cents } from "@cubby/shared";
import { sha256Hex } from "@cubby/shared/sha256";

import { STATEMENT_CHARGE_IDENTITY_FEATURE } from "~/server/ai/policy/features";
import { STATEMENT_SUGGESTION_REVISION } from "~/server/domains/statement-import/repo/statement-suggestions";

/** What a field rule reads: the published proposal and its Sweep's pinned model. */
export type FieldRuleFacts = {
  entity: ShortcodeEntity;
  field: string;
  kind: string;
  confidence: number;
  model: string;
  /** The Sweep Run's pinned decision model; null outside a Sweep. */
  pinnedModel: string | null;
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
  /**
   * Precision is kept per decision model, and a match applies only while
   * its own model's window is eligible: switching the rule on for one
   * measured model never authorizes another.
   */
  perModel: boolean;
  execution: "measured" | "import_clean" | "field_policy";
  /** The match's model qualifier (null unless `perModel`), or undefined for no match. */
  match: (facts: FactsOf[F]) => { model: string | null } | undefined;
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
      "Fill an empty declared assignment field at 95% confidence with current evidence and a clear winner, preserving member decisions.",
    revision: () => FIELD_ASSIGNMENT_REVISION,
    perModel: false,
    match: (facts) =>
      facts.kind === "addition" &&
      entityFieldByKey(facts.entity, facts.field)?.control?.suggest?.mode ===
        "fill" &&
      !requiresSuggestionReview(facts.entity, facts.field) &&
      facts.confidence >= SUGGESTION_AUTO_APPLY_THRESHOLD
        ? { model: null }
        : undefined,
    application: () => ({ kind: "accept_as_is" }),
  },
  "statement_transaction.attach": {
    execution: "measured",
    family: "statement_transaction",
    description:
      "Attach a charge to its only candidate when no sibling could be the same money, no other charge already settles that candidate, the amounts match to the cent, and the decision model labels it the same charge with high confidence.",
    revision: () =>
      `${STATEMENT_SUGGESTION_REVISION}/${STATEMENT_CHARGE_IDENTITY_FEATURE.promptVersion}`,
    perModel: true,
    match: (judgment) => {
      const only = soleCandidate(judgment);
      return judgment.recommended === "attach" &&
        (!(
          judgment.create?.status === "posted" &&
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
        only.label.model
        ? { model: only.label.model }
        : undefined;
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
      "Book every clean posted spending observation from an import through the shared reviewed booking path.",
    revision: () => STATEMENT_SUGGESTION_REVISION,
    perModel: false,
    match: (judgment) =>
      judgment.clean && judgment.spending?.status === "ready"
        ? { model: null }
        : undefined,
    application: () => ({ kind: "accept_as_is" }),
  },
} satisfies { [K in AutomaticRuleKey]: Declaration<FamilyOf<K>> };

export type AutomaticRuleMatch = {
  key: AutomaticRuleKey;
  revision: string;
  stamp: string;
  application: RuleApplication;
};

/** `<ruleKey>@<revision>`; its windows are this base or `<base>@<model>`. */
export const ruleBase = (key: AutomaticRuleKey) =>
  `${key}@${AUTOMATIC_RULES[key].revision()}`;

function evaluate<F extends AutomaticRuleFamily>(
  key: AutomaticRuleKey,
  rule: Declaration<F>,
  facts: FactsOf[F],
): AutomaticRuleMatch[] {
  const match = rule.match(facts);
  if (!match) return [];
  const base = ruleBase(key);
  return [
    {
      key,
      revision: rule.revision(),
      stamp: match.model ? `${base}@${match.model}` : base,
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

/** The deterministic 5% of a family's subjects held for review. */
async function isAuditSample(family: string, subjectKey: string) {
  const digest = await sha256Hex(`${family}:${subjectKey}`);
  return BigInt(`0x${digest}`) % BigInt(AUTOMATIC_RULE_AUDIT_EVERY) === 0n;
}

/** Audit choice; tests substitute one so their outcome never rides on random ids. */
export type AuditSampler = (
  family: string,
  subjectKey: string,
) => Promise<boolean> | boolean;

/**
 * The publication stamp an AssessmentState carries in `data`: the rules it
 * matched when published and whether it is held as an audit sample. Empty
 * when nothing matched, so unmatched rows keep their prior shape.
 */
export async function automaticRuleStamp(
  family: AutomaticRuleFamily,
  matches: readonly AutomaticRuleMatch[],
  subjectKey: string,
  sample: AuditSampler = isAuditSample,
): Promise<{ matchedRules?: string[]; auditSample?: boolean }> {
  if (!matches.length) return {};
  return {
    matchedRules: matches.map((match) => match.stamp),
    auditSample: await sample(family, subjectKey),
  };
}

export const fieldSubjectKey = (row: {
  entity: string;
  recordId: string;
  field: string;
}) => `${row.entity}:${row.recordId}:${row.field}`;
export const statementSubjectKey = (row: {
  source: string;
  chargeKey: string;
}) => `${row.source}:${row.chargeKey}`;
