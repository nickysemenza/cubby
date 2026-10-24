import { suggestionStatus } from "@cubby/schemas/ai";
import { assessmentFamily } from "@cubby/schemas/assessment";
import {
  AUTOMATIC_RULE_KEYS,
  automaticRuleOut,
  automaticRulesOut,
  setAutomaticRuleInput,
  type AutomaticRuleKey,
} from "@cubby/schemas/automatic-rule";
import type { ActorContext } from "@cubby/schemas/context";
import { shortcodeEntities } from "@cubby/schemas/entity-manifest";
import { runEntityId } from "@cubby/schemas/identifiers";
import { statementTransactionJudgment } from "@cubby/schemas/statement-suggestion";
import { createLogger } from "@cubby/worker-tracing";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";

import { scrubErrorMessage } from "~/lib/error-diagnostics";
import type { Database } from "~/server/db";
import { getDb, unwrapDb } from "~/server/db/helpers";
import { assessment, automaticRule } from "~/server/db/schema";
import { systemActor } from "~/server/domains/run/repo/ensure-run";
import type { EntityKernelContext } from "~/server/entity-kernel/adapter";
import { createAppError } from "~/server/errors/app-error";
import { matchedRulesOf } from "~/server/generic/assessment/repo/assessment";
import { reviewAssessment } from "~/server/generic/assessment/repo/assessment-review";
import {
  AUTOMATIC_RULES,
  type AutomaticRuleMatch,
  matchFieldRules,
  matchStatementRules,
  ruleBase,
} from "~/server/generic/assessment/repo/automatic-rules";
import { canAutomaticallyFillField } from "~/server/generic/assessment/repo/suggestion-review";

const log = createLogger("automatic-rules");

const ruleStamps = z
  .object({ matchedRules: z.array(z.string()).default([]) })
  .passthrough();

async function storedRules(db: Database) {
  const rows = await getDb(db).select().from(automaticRule);
  return new Map(rows.map((row) => [row.ruleKey, row]));
}

type StoredRule = typeof automaticRule.$inferSelect;
/** Import booking defaults on; an explicit pause survives policy revisions. */
const isOn = (key: AutomaticRuleKey, row: StoredRule | undefined) =>
  AUTOMATIC_RULES[key].execution === "field_policy" ||
  (AUTOMATIC_RULES[key].execution === "import_clean"
    ? (row?.enabled ?? true)
    : Boolean(
        row?.enabled && row.revision === AUTOMATIC_RULES[key].revision(),
      ));

/**
 * Inside the application's transaction: the rule is still on for this
 * revision. The share lock serializes the application with a member's
 * switch, so a rule turned off before the application commits applies
 * nothing.
 */
export async function assertAutomaticRuleOn(
  db: Database,
  key: AutomaticRuleKey,
  stamp: string,
  assessmentId: string | null,
) {
  const rule = AUTOMATIC_RULES[key];
  if (rule.execution !== "member_switch") {
    if (stamp !== ruleBase(key))
      throw new Error("Automatic policy changed; refresh the suggestion");
    if (rule.execution === "field_policy") return;
    // Materialize the default before locking: a concurrent first pause must
    // serialize with this application even when no switch row existed yet.
    await getDb(db)
      .insert(automaticRule)
      .values({
        family: rule.family,
        ruleKey: key,
        revision: rule.revision(),
        enabled: true,
      })
      .onConflictDoNothing({
        target: [automaticRule.family, automaticRule.ruleKey],
      });
  } else {
    if (assessmentId === null)
      throw new Error(
        "A member-switched automatic rule requires its retained Assessment.",
      );
    const [prediction] = await getDb(db)
      .select({ judgment: assessment.judgment })
      .from(assessment)
      .where(eq(assessment.id, assessmentId))
      .limit(1);
    const judgment = statementTransactionJudgment.safeParse(
      prediction?.judgment,
    );
    if (judgment.success) {
      const booking = matchStatementRules(judgment.data).find(
        (match) => AUTOMATIC_RULES[match.key].execution === "import_clean",
      );
      // Attaching a clean spending charge also books it; it shares the pause.
      if (booking)
        await assertAutomaticRuleOn(
          db,
          booking.key,
          booking.stamp,
          assessmentId,
        );
    }
  }
  const [row] = await getDb(db)
    .select()
    .from(automaticRule)
    .where(eq(automaticRule.ruleKey, key))
    .for("share");
  if (!isOn(key, row))
    throw new Error(`Automatic rule ${key} is off; review the suggestion`);
}

function ruleSummary(key: AutomaticRuleKey, row: StoredRule | undefined) {
  const rule = AUTOMATIC_RULES[key];
  return automaticRuleOut.parse({
    family: rule.family,
    ruleKey: key,
    revision: rule.revision(),
    description: rule.description,
    enabled: isOn(key, row),
    enabledRevision: row?.revision ?? rule.revision(),
    enabledAt: row?.enabledAt?.toISOString() ?? null,
    enabledByUserId: row?.enabledByUserId ?? null,
    enabledReason: row?.enabledReason ?? null,
    disabledAt: row?.disabledAt?.toISOString() ?? null,
    disabledReason: row?.disabledReason ?? null,
  });
}

/** Every member-switched rule and its switch. */
export async function listAutomaticRules(db: Database) {
  const stored = await storedRules(db);
  return automaticRulesOut.parse({
    rules: AUTOMATIC_RULE_KEYS.filter(
      (key) => AUTOMATIC_RULES[key].execution !== "field_policy",
    ).map((key) => ruleSummary(key, stored.get(key))),
  });
}

/** A member turns a rule on for its declared revision, or off. */
export async function setAutomaticRule(
  db: Database,
  actor: ActorContext,
  raw: z.input<typeof setAutomaticRuleInput>,
) {
  const input = setAutomaticRuleInput.parse(raw);
  if (actor.userId === systemActor().userId)
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "Only a member turns an Automatic rule on or off",
    );
  const rule = AUTOMATIC_RULES[input.ruleKey];
  if (rule.execution === "field_policy")
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "This automatic policy is not an optional member switch.",
    );
  const now = new Date();
  const change = input.enabled
    ? {
        revision: rule.revision(),
        enabled: true,
        enabledAt: now,
        enabledByUserId: actor.userId,
        enabledReason: `Turned on by a member for ${ruleBase(input.ruleKey)}`,
        disabledAt: null,
        disabledReason: null,
      }
    : {
        enabled: false,
        disabledAt: now,
        disabledReason: "Turned off by a member",
      };
  await getDb(db)
    .insert(automaticRule)
    .values({
      family: rule.family,
      ruleKey: input.ruleKey,
      revision: rule.revision(),
      ...change,
    })
    .onConflictDoUpdate({
      target: [automaticRule.family, automaticRule.ruleKey],
      set: change,
    });
  return ruleSummary(input.ruleKey, (await storedRules(db)).get(input.ruleKey));
}

const shortcodeEntity = z.enum(shortcodeEntities);

type Candidate = {
  id: string;
  family: string;
  status: string;
  active: boolean;
  served: boolean;
  data: unknown;
  entity: string;
  field: string;
  kind: string;
  confidence: number;
  model: string;
  fingerprint: string | null;
  runId: string | null;
  judgment: unknown;
};

function currentMatches(row: Candidate): AutomaticRuleMatch[] {
  if (row.family === "field") {
    const entity = shortcodeEntity.safeParse(row.entity);
    return entity.success
      ? matchFieldRules({
          entity: entity.data,
          field: row.field,
          kind: row.kind,
          confidence: row.confidence,
          model: row.model,
        })
      : [];
  }
  if (row.family === "statement_transaction") {
    const judgment = statementTransactionJudgment.safeParse(row.judgment);
    return judgment.success ? matchStatementRules(judgment.data) : [];
  }
  return [];
}

export type AutomaticRuleOutcome = {
  applied: string[];
  refused: { assessmentId: string; message: string }[];
};

/**
 * Applies each pending Assessment that matches a rule that is on, through
 * `reviewAssessment` and its family's full apply path (fingerprint recheck,
 * applied-first state, one transaction), as the system actor. A match must
 * hold both now and in its publication stamp, so evidence that drifted since
 * publication is never applied. Replays are idempotent: an applied
 * Assessment is no longer pending, and the operation id is fixed per rule
 * revision and Assessment.
 */
export async function applyAutomaticRules(
  db: Database,
  assessmentIds: readonly string[],
  options: {
    /** Kernel services for field writes; the actor is always the system's. */
    context?: EntityKernelContext;
    onFailure?: (assessmentId: string, message: string) => void;
    /** An import authorizes clean spending plans while their rule is enabled. */
    importClean?: boolean;
  } = {},
): Promise<AutomaticRuleOutcome> {
  const outcome: AutomaticRuleOutcome = { applied: [], refused: [] };
  if (!assessmentIds.length) return outcome;
  const { rows } = await unwrapDb(db).execute<Candidate>(sql`
    SELECT s.id, s.family, s.status, s.active, a.served, s.data, s.entity, s.field,
      s.kind, s.confidence, s.model, s.fingerprint, s."runId", a.judgment
    FROM "AssessmentState" s
    JOIN "Assessment" a ON a.id = s.id
    WHERE s.id IN (${sql.join(
      assessmentIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    )})
  `);
  const stored = await storedRules(db);
  let base = options.context;
  for (const row of rows) {
    if (!row.active || row.status !== "pending" || !row.served) continue;
    if (row.family === "field") {
      const { fieldCorrectionKey, readFieldCorrectionSources } =
        await import("./correction-sources");
      const key = fieldCorrectionKey(row.data);
      if (key) {
        const { isCurrentFieldCorrection } =
          await import("./field-correction-repair");
        const sources = await readFieldCorrectionSources(db, key);
        let corrected = false;
        for (const source of sources)
          if (await isCurrentFieldCorrection(db, source)) corrected = true;
        // Root member authority is resolved by correction work, not model confidence.
        // Conflicting corrections also withhold the old model answer.
        if (corrected) continue;
      }
    }
    const stamp = ruleStamps.safeParse(row.data).data;
    if (row.family !== "field" && !stamp?.matchedRules.length) continue;
    const current = currentMatches(row);
    if (
      current.some(
        (match) =>
          AUTOMATIC_RULES[match.key].execution === "import_clean" &&
          !isOn(match.key, stored.get(match.key)),
      )
    )
      continue;
    const matches = current
      .filter(
        (match) =>
          (row.family === "field" ||
            stamp?.matchedRules.includes(match.stamp)) &&
          (AUTOMATIC_RULES[match.key].execution !== "import_clean" ||
            options.importClean === true) &&
          isOn(match.key, stored.get(match.key)),
      )
      .sort(
        (a, b) =>
          Number(AUTOMATIC_RULES[b.key].execution === "import_clean") -
          Number(AUTOMATIC_RULES[a.key].execution === "import_clean"),
      );
    const [match] = matches;
    if (!match) continue;
    try {
      let application;
      if (match.application.kind === "statement_attach") {
        const { rows: codes } = await unwrapDb(db).execute<{
          shortcode: string;
        }>(sql`
          SELECT shortcode FROM "FinancialTransaction"
          WHERE id = ${match.application.transactionId}::uuid AND "deletedAt" IS NULL
        `);
        if (!codes[0])
          throw new Error(
            "The rule's candidate transaction no longer exists; review the suggestion",
          );
        application = {
          kind: "statement_transaction" as const,
          action: "attach" as const,
          transactionId: codes[0].shortcode,
          // An automatic attach never copies statement fields onto the transaction.
          fields: [],
          rejectedCandidateIds: [],
        };
      }
      if (!application && row.family === "statement_transaction") {
        const judgment = statementTransactionJudgment.parse(row.judgment);
        application = {
          kind: "statement_transaction" as const,
          action: judgment.recommended,
          fields: [],
          rejectedCandidateIds: [],
        };
      }
      base ??= {
        ...(await import("~/server/http/request-context")).buildCrudServices(
          db,
        ),
        db,
        actorContext: systemActor(),
      };
      const context: EntityKernelContext = {
        ...base,
        db,
        actorContext: {
          ...systemActor(),
          runId: row.runId ? runEntityId.parse(row.runId) : null,
        },
      };
      // Ineligible or stale field work stays reviewable/refreshable without
      // reporting an expected policy hold as an application error every pass.
      if (
        row.family === "field" &&
        !(await canAutomaticallyFillField(db, context, row.id))
      )
        continue;
      await reviewAssessment(
        db,
        context,
        {
          assessmentId: row.id,
          operationId: `automatic:${match.key}@${match.revision}:${row.id}`,
          verdict: "correct",
          correction: { present: false },
          intent: "apply",
          expectedFingerprint: row.fingerprint,
          reason: null,
          evidence: null,
          ...(application && { application }),
        },
        {
          authority: "automatic",
          rule: {
            key: match.key,
            revision: match.revision,
            stamp: match.stamp,
          },
        },
      );
      outcome.applied.push(row.id);
    } catch (error) {
      if (
        (
          await import("~/server/workflows/runs/execution")
        ).isWorkflowInterrupted(error)
      )
        throw error;
      // A refusal leaves the suggestion pending for review, which is the
      // rule's safe outcome; the raw reason is returned and logged.
      const message = scrubErrorMessage(
        error instanceof Error ? error.message : String(error),
      );
      outcome.refused.push({ assessmentId: row.id, message });
      options.onFailure?.(row.id, message);
      log.warn("Automatic rule application refused", {
        assessmentId: row.id,
        rule: match.stamp,
        error: message,
      });
    }
  }
  return outcome;
}

/** After decision labels publish a charge: its current pending suggestion. */
export async function applyAutomaticRulesForCharge(
  db: Database,
  charge: { source: string; chargeKey: string },
  importClean = false,
) {
  const { rows } = await unwrapDb(db).execute<{ id: string }>(sql`
    SELECT id FROM "AssessmentState"
    WHERE family = ${assessmentFamily.enum.statement_transaction} AND active
      AND status = ${suggestionStatus.enum.pending}
      AND data->>${"source"} = ${charge.source} AND data->>${"chargeKey"} = ${charge.chargeKey}
      AND jsonb_array_length(${matchedRulesOf(sql`data`)}) > 0
  `);
  return applyAutomaticRules(
    db,
    rows.map((row) => row.id),
    { importClean },
  );
}
