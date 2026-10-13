import { fieldSuggestionsInput, fieldSuggestionsOut } from "@cubby/schemas/ai";
import {
  aiEvaluationState,
  suggestionSupersessionReceipt,
  aiEvaluationTarget,
  aiProvenance,
  aiRefreshRunInput,
  type AiEvaluationTarget,
  type AiProvenance,
} from "@cubby/schemas/ai-evaluation";
import { buildActorContext } from "@cubby/schemas/context";
import { entityRefKey } from "@cubby/schemas/entity";
import {
  parseEntityRef,
  runEntityId,
  userId,
} from "@cubby/schemas/identifiers";
import { EMAIL_RECLASSIFY_LIMIT } from "@cubby/schemas/mailbox-research";
import {
  selectDecisionModel,
  supportedDecisionModelSchema,
} from "@cubby/shared/ai/models";
import { sha256Hex } from "@cubby/shared/sha256";
import { createLogger } from "@cubby/worker-tracing";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { z } from "zod";

import { scrubErrorMessage } from "~/lib/error-diagnostics";
import { decisionCatalogRows } from "~/server/ai/decision-catalog";
import { withAiInputs } from "~/server/ai/evaluation-inputs";
import {
  suggestFields,
  type SuggestFieldsPorts,
} from "~/server/ai/field-suggest/suggest-fields";
import {
  compiledRefreshManifest,
  dependencyStamps,
  fieldDependencyKeys,
  dependenciesCurrent,
  fieldPolicyKey,
} from "~/server/ai/refresh-policy";
import type { Database } from "~/server/db";
import {
  aiEvaluation,
  email,
  emailClassificationObservation,
  ledgerParty,
  run,
  suggestion,
} from "~/server/db/schema";
import { executeEntity } from "~/server/entity-kernel";
import type { EntityKernelContext } from "~/server/entity-kernel/adapter";
import { entityCommandSchema } from "~/server/entity-kernel/contracts";
import {
  claimAiEvaluation,
  guardAiEvaluation,
  publishAiEvaluation,
} from "~/server/repo/ai-evaluation";
import {
  readAiRefreshActivation,
  readAiDiscoveryCursor,
  saveAiDiscoveryCursor,
} from "~/server/repo/ai-refresh";
import { latestFieldWrite } from "~/server/repo/audit-log";
import {
  getDb,
  notDeleted,
  withTransactionDatabase,
} from "~/server/repo/database-helpers";
import { emailMemberClassificationSql } from "~/server/repo/email-sql";
import { canonicalJson } from "~/server/repo/entity-source";
import { lookupShortcodes } from "~/server/repo/shortcode-resolver";
import { buildCrudServices } from "~/server/request-context";

import { ensureRun, systemActor } from "./ensure-run";
import {
  makeSweepSuggestion,
  publishSweepSuggestions,
} from "./suggestion-sweep";

export type AiRefreshPorts = {
  context?: EntityKernelContext;
  suggestPorts?: SuggestFieldsPorts;
  emailPorts?: Pick<
    Parameters<
      typeof import("~/server/purchase-import/gmail/ingest").ingestGmailMessages
    >[2],
    "triage" | "relevance" | "storage"
  >;
};
const log = createLogger("ai-refresh");
const fieldSnapshot = z.object({
  publicId: z.string(),
  entity: fieldSuggestionsInput.shape.entity,
  field: z.string(),
  currentValue: z.json(),
  fieldDecisionId: z.uuid().nullable().default(null),
  decisionModel: supportedDecisionModelSchema.default("typesafe/jev"),
  basis: z.record(z.string(), z.string().nullable()),
});
const fieldResult = z.object({
  output: fieldSuggestionsOut,
  provenance: aiProvenance,
});
const jsonSnapshot = (value: unknown) =>
  z.json().parse(JSON.parse(JSON.stringify(value)));

function kernel(
  db: Database,
  ports: AiRefreshPorts,
  runId?: string,
): EntityKernelContext {
  const context = ports.context ?? {
    ...buildCrudServices(db),
    actorContext: systemActor(),
  };
  return {
    ...context,
    db,
    actorContext: {
      ...context.actorContext,
      runId: runId ? runEntityId.parse(runId) : context.actorContext.runId,
    },
  };
}

async function prepareField(
  db: Database,
  target: Extract<AiEvaluationTarget, { kind: "field" }>,
  ports: AiRefreshPorts,
) {
  const parsedEntity = fieldSuggestionsInput.shape.entity.safeParse(
    target.entity,
  );
  if (!parsedEntity.success) return null;
  const entity = parsedEntity.data;
  const ref = parseEntityRef(entity, target.recordId);
  const codes = await lookupShortcodes(db, [ref]);
  const publicId = codes.get(entityRefKey(entity, target.recordId));
  if (!publicId) return null;
  const context = kernel(db, ports);
  const found = await executeEntity(
    context,
    entityCommandSchema.parse({
      action: "get",
      entity,
      id: publicId,
      missing: "null",
    }),
  );
  if (found.action !== "get" || !found.item) return null;
  const record = z.record(z.string(), z.unknown()).parse(found.item);
  const policy = decisionCatalogRows().find(
    (row) => row.entity === entity && row.field === target.field,
  );
  if (!policy) return null;
  const basis = Object.fromEntries(
    [...new Set([...policy.basis.map((row) => row.key), target.field])].map(
      (key) => [
        key,
        record[key] == null
          ? null
          : typeof record[key] === "string"
            ? record[key]
            : JSON.stringify(record[key]),
      ],
    ),
  );
  const lastWrite = await latestFieldWrite(
    db,
    entity,
    target.recordId,
    target.field,
  );
  const snapshot = fieldSnapshot.parse({
    publicId,
    entity,
    field: target.field,
    basis,
    fieldDecisionId: lastWrite?.id ?? null,
    decisionModel: ports.suggestPorts?.decisionModel ?? selectDecisionModel(),
    currentValue: record[target.field] ?? null,
  });
  const activation = await readAiRefreshActivation(db);
  const manifest = activation?.manifest ?? (await compiledRefreshManifest());
  const prepared = await withAiInputs(true, () =>
    suggestFields(
      db,
      context.actorContext.runId ??
        runEntityId.parse("00000000-0000-4000-8000-000000000000"),
      {
        entity,
        entityId: publicId,
        targets: [target.field],
        basisMode: "provided",
        basis,
      },
      {
        ...ports.suggestPorts,
        decisionModel: snapshot.decisionModel,
        recordUsage: false,
      },
    ),
  );
  const provenance = aiProvenance.parse({
    dependencies: dependencyStamps(manifest, [
      ...fieldDependencyKeys(entity, target.field),
      ...prepared.inputs.map((call) => call.feature),
    ]),
    inputFingerprint: await sha256Hex(
      JSON.stringify({
        basis,
        fieldDecisionId: snapshot.fieldDecisionId,
        inputs: [
          ...new Set(prepared.inputs.map((call) => call.fingerprint)),
        ].sort(),
      }),
    ),
    optionFingerprint:
      manifest[fieldPolicyKey(entity, target.field)]?.policyFingerprint ?? "",
    model: null,
  });
  return { snapshot, provenance, lastWrite };
}

async function insertTarget(
  db: Database,
  runId: string,
  target: AiEvaluationTarget,
  provenance: AiProvenance,
  snapshot: unknown,
  blockedReason?: string,
) {
  const workKey = await sha256Hex(
    JSON.stringify({
      entity: target.entity,
      recordId: target.recordId,
      field: target.field,
      provenance: { ...provenance, model: null },
    }),
  );
  const inserted = await getDb(db)
    .insert(aiEvaluation)
    .values({
      runId: runEntityId.parse(runId),
      feature: target.kind === "field" ? "field-suggestion" : "mailbox-triage",
      workKey,
      target,
      provenance,
      snapshot: jsonSnapshot(snapshot),
      ...(blockedReason
        ? {
            state: "blocked" as const,
            error: blockedReason,
            receipt: { reason: "mailbox_authorization_unavailable" },
          }
        : {}),
    })
    .onConflictDoNothing()
    .returning({ id: aiEvaluation.id });
  return inserted.length;
}

async function scheduleEvaluationRun(
  db: Database,
  actor: Parameters<typeof ensureRun>[1],
  input: Parameters<typeof ensureRun>[2],
  targets: {
    target: AiEvaluationTarget;
    provenance: AiProvenance;
    snapshot: unknown;
    blockedReason?: string;
  }[],
) {
  return withTransactionDatabase(db, async (tx) => {
    const runId = await ensureRun(tx, actor, input);
    // Work and its owner become visible together, before recovery can launch a Workflow.
    await getDb(tx)
      .select({ id: run.id })
      .from(run)
      .where(eq(run.id, runId))
      .for("no key update");
    let inserted = 0;
    for (const item of targets)
      inserted += await insertTarget(
        tx,
        runId,
        item.target,
        item.provenance,
        item.snapshot,
        item.blockedReason,
      );
    if (!inserted)
      await getDb(tx)
        .update(run)
        .set({ status: "completed", endedAt: new Date() })
        .where(
          and(
            eq(run.id, runId),
            eq(run.status, "running"),
            sql`NOT EXISTS (SELECT 1 FROM "AiEvaluation" WHERE "runId" = ${run.id})`,
          ),
        );
    return inserted && input.status !== "completed" ? runId : null;
  });
}

/** Preparation enumerates evidence using live renderers; no model calls happen here. */
export async function discoverAiRefresh(
  db: Database,
  ports: AiRefreshPorts = {},
) {
  const activation = await readAiRefreshActivation(db);
  if (!activation?.enabled) return [];
  const runs = new Set<string>();
  const cursor = await readAiDiscoveryCursor(db);
  const eligibleSuggestions = or(
    eq(suggestion.status, "pending"),
    and(
      eq(suggestion.status, "superseded"),
      sql`${suggestion.supersessionReceipt}->>'reason' IN (${suggestionSupersessionReceipt.shape.reason.enum.input_changed}, ${suggestionSupersessionReceipt.shape.reason.enum.no_proposal})`,
    ),
  );
  const pending = await getDb(db)
    .selectDistinctOn([
      suggestion.entity,
      suggestion.recordId,
      suggestion.field,
    ])
    .from(suggestion)
    .where(
      and(
        eligibleSuggestions,
        cursor.field
          ? sql`(${suggestion.entity}, ${suggestion.recordId}, ${suggestion.field}) > (${cursor.field.entity}, ${cursor.field.recordId}::uuid, ${cursor.field.field})`
          : undefined,
      ),
    )
    .orderBy(
      asc(suggestion.entity),
      asc(suggestion.recordId),
      asc(suggestion.field),
      desc(suggestion.createdAt),
    )
    .limit(EMAIL_RECLASSIFY_LIMIT);
  const grouped = new Map<string, typeof pending>();
  for (const row of pending) {
    const history = await getDb(db)
      .select()
      .from(suggestion)
      .where(
        and(
          eq(suggestion.entity, row.entity),
          eq(suggestion.recordId, row.recordId),
          eq(suggestion.field, row.field),
          eligibleSuggestions,
        ),
      )
      .orderBy(desc(suggestion.createdAt));
    grouped.set(`${row.entity}:${row.recordId}:${row.field}`, history);
  }
  for (const rows of grouped.values()) {
    try {
      const first = rows[0]!;
      const target = aiEvaluationTarget.parse({
        kind: "field",
        entity: first.entity,
        recordId: first.recordId,
        field: first.field,
        suggestionIds: rows.map((row) => row.id),
      });
      if (target.kind !== "field") continue;
      const prepared = await prepareField(db, target, ports);
      if (
        !prepared ||
        (prepared.lastWrite && prepared.lastWrite.createdAt > first.createdAt)
      )
        continue;
      if (
        first.provenance &&
        dependenciesCurrent(first.provenance, activation.manifest) &&
        first.provenance.inputFingerprint ===
          prepared.provenance.inputFingerprint
      )
        continue;
      if (
        canonicalJson(z.json().parse(first.currentValue ?? null)) !==
        canonicalJson(prepared.snapshot.currentValue)
      )
        continue;
      const key = await sha256Hex(
        JSON.stringify({
          target: {
            entity: target.entity,
            recordId: target.recordId,
            field: target.field,
          },
          provenance: prepared.provenance,
        }),
      );
      const runId = await scheduleEvaluationRun(
        db,
        ports.context?.actorContext ?? systemActor(),
        {
          purpose: "ai_refresh",
          trigger: "scheduled",
          status: "running",
          clientKey: `ai-refresh:field:${key}`,
          input: aiRefreshRunInput.parse({ kind: "ai_refresh", activation }),
        },
        [
          {
            target,
            provenance: prepared.provenance,
            snapshot: prepared.snapshot,
          },
        ],
      );
      if (runId) runs.add(runId);
    } catch (error) {
      log.error("Field refresh discovery failed", {
        error: scrubErrorMessage(String(error)),
      });
    }
  }
  const candidates = await getDb(db)
    .select({ item: email, ownerUserId: ledgerParty.userId })
    .from(email)
    .innerJoin(
      ledgerParty,
      and(eq(email.ledgerPartyId, ledgerParty.id), notDeleted(ledgerParty)),
    )
    .where(
      and(
        cursor.email ? gt(email.id, cursor.email) : undefined,
        notDeleted(email),
        eq(email.classification, "uncertain"),
        notInArray(email.status, [
          "completed",
          "deleted",
          "excluded",
          "researching",
        ]),
        isNull(emailMemberClassificationSql()),
      ),
    )
    .orderBy(asc(email.id))
    .limit(EMAIL_RECLASSIFY_LIMIT * 2);
  const observations = candidates.length
    ? await getDb(db)
        .select()
        .from(emailClassificationObservation)
        .where(
          inArray(
            emailClassificationObservation.emailId,
            candidates.map(({ item }) => item.id),
          ),
        )
        .orderBy(desc(emailClassificationObservation.createdAt))
    : [];
  const latest = new Map<string, (typeof observations)[number]>();
  for (const observation of observations)
    if (!latest.has(observation.emailId))
      latest.set(observation.emailId, observation);
  const mailboxes = new Map<string, typeof candidates>();
  for (const candidate of candidates) {
    const observation = latest.get(candidate.item.id);
    if (
      observation?.checksum === candidate.item.checksum &&
      ["mailbox-triage", "mailbox-relevance"].every((feature) =>
        observation.provenance?.dependencies.some(
          (stamp) => stamp.feature === feature,
        ),
      ) &&
      observation.provenance &&
      dependenciesCurrent(observation.provenance, activation.manifest)
    )
      continue;
    mailboxes.set(`${candidate.ownerUserId}:${candidate.item.mailboxId}`, [
      ...(mailboxes.get(
        `${candidate.ownerUserId}:${candidate.item.mailboxId}`,
      ) ?? []),
      candidate,
    ]);
  }
  for (const group of mailboxes.values())
    for (let start = 0; start < group.length; start += EMAIL_RECLASSIFY_LIMIT) {
      try {
        const batch = group.slice(start, start + EMAIL_RECLASSIFY_LIMIT);
        const first = batch[0]!;
        if (!first.ownerUserId) continue;
        const { mailboxApproval } =
          await import("~/server/purchase-import/gmail/reclassify");
        const owner = {
          userId: userId.parse(first.ownerUserId),
          ledgerPartyId: first.item.ledgerPartyId,
        };
        let approval: Awaited<ReturnType<typeof mailboxApproval>> | undefined;
        let authorizationError: string | undefined;
        try {
          approval = await mailboxApproval(db, owner, first.item.mailboxId);
        } catch (error) {
          authorizationError = scrubErrorMessage(String(error));
        }
        const dependencies = dependencyStamps(activation.manifest, [
          "mailbox-triage",
          "mailbox-relevance",
        ]);
        const key = await sha256Hex(
          JSON.stringify({
            dependencies,
            authorization: approval ?? null,
            mailboxId: first.item.mailboxId,
            sources: batch.map(({ item }) => ({
              id: item.id,
              checksum: item.checksum,
              contentClearedAt: item.contentClearedAt,
              orderMailId: item.orderMailId,
            })),
          }),
        );
        const targets = await Promise.all(
          batch.map(async ({ item }) => ({
            target: aiEvaluationTarget.parse({
              kind: "email",
              entity: "email",
              recordId: item.id,
              field: null,
              suggestionIds: [],
            }),
            provenance: aiProvenance.parse({
              dependencies,
              inputFingerprint: await sha256Hex(
                JSON.stringify({
                  checksum: item.checksum,
                  contentClearedAt: item.contentClearedAt,
                  orderMailId: item.orderMailId,
                  authorization: approval ?? null,
                }),
              ),
              optionFingerprint: "",
              model: null,
            }),
            snapshot: item,
            blockedReason: authorizationError,
          })),
        );
        const runId = await scheduleEvaluationRun(
          db,
          buildActorContext(owner.userId, "system"),
          {
            purpose: "ai_refresh",
            trigger: "scheduled",
            status: authorizationError ? "completed" : "running",
            progress: {
              attempt: 0,
              selected: batch.length,
              blocked: authorizationError ? batch.length : 0,
              completed: 0,
              failed: 0,
            },
            clientKey: `ai-refresh:email:${key}`,
            input: aiRefreshRunInput.parse({
              kind: "ai_refresh",
              activation,
              executionAuthorization: approval,
              mailboxId: first.item.mailboxId,
              emails: batch.map(({ item }) => ({
                emailId: item.id,
                checksum: item.checksum,
              })),
            }),
          },
          targets,
        );
        if (runId) runs.add(runId);
      } catch (error) {
        log.error("Email refresh discovery failed", {
          error: scrubErrorMessage(String(error)),
        });
      }
    }
  const lastField = pending.at(-1);
  await saveAiDiscoveryCursor(db, {
    field:
      pending.length === EMAIL_RECLASSIFY_LIMIT && lastField
        ? {
            entity: lastField.entity,
            recordId: lastField.recordId,
            field: lastField.field,
          }
        : null,
    email:
      candidates.length === EMAIL_RECLASSIFY_LIMIT * 2
        ? candidates.at(-1)!.item.id
        : null,
  });
  return [...runs];
}

export async function executeAiRefreshTarget(
  db: Database,
  id: string,
  ports: AiRefreshPorts = {},
) {
  const claimed = await claimAiEvaluation(db, id);
  if (!claimed?.attemptToken) return false;
  const token = claimed.attemptToken;
  try {
    await withTransactionDatabase(db, (tx) => guardAiEvaluation(tx, id, token));
    const compiled = await compiledRefreshManifest();
    if (
      !dependenciesCurrent(
        {
          ...claimed.provenance,
          dependencies: claimed.provenance.dependencies.map((stamp) => ({
            ...stamp,
            generation: 0,
          })),
        },
        compiled,
      )
    )
      throw new Error("AI evaluation Worker prompt manifest is obsolete");
    const target = aiEvaluationTarget.parse(claimed.target);
    if (target.kind === "email") {
      const { refreshEmailEvaluation } =
        await import("~/server/purchase-import/gmail/refresh-evaluation");
      await refreshEmailEvaluation(db, claimed, ports.emailPorts);
      return true;
    }
    const prepared = await prepareField(db, target, ports);
    if (
      !prepared ||
      prepared.provenance.inputFingerprint !==
        claimed.provenance.inputFingerprint
    )
      throw new Error("AI evaluation target changed during inference");
    const snapshot = fieldSnapshot.parse(claimed.snapshot);
    const previous = await getDb(db)
      .select()
      .from(suggestion)
      .where(inArray(suggestion.id, target.suggestionIds));
    if (previous.some((row) => !["pending", "superseded"].includes(row.status)))
      throw new Error("AI evaluation member decision is obsolete");
    let result = fieldResult.safeParse(claimed.result);
    if (!result.success) {
      const evaluated = await withAiInputs(false, () =>
        suggestFields(
          db,
          claimed.runId,
          {
            entity: snapshot.entity,
            entityId: snapshot.publicId,
            targets: [snapshot.field],
            basisMode: "provided",
            basis: snapshot.basis,
          },
          { ...ports.suggestPorts, decisionModel: snapshot.decisionModel },
        ),
      );
      const provenance = {
        ...prepared.provenance,
        model: evaluated.inputs[0]?.model ?? snapshot.decisionModel,
      };
      result = fieldResult.safeParse({ output: evaluated.result, provenance });
      if (!result.success) throw result.error;
      const [saved] = await getDb(db)
        .update(aiEvaluation)
        .set({ state: "result_ready", result: jsonSnapshot(result.data) })
        .where(
          and(
            eq(aiEvaluation.id, id),
            eq(aiEvaluation.attemptToken, token),
            eq(aiEvaluation.state, "running"),
          ),
        )
        .returning({ id: aiEvaluation.id });
      if (!saved) throw new Error("AI evaluation attempt is obsolete");
    }
    const saved = result.data;
    await publishAiEvaluation(db, id, token, async (tx) => {
      const now = await prepareField(tx, target, ports);
      if (
        !now ||
        now.provenance.inputFingerprint !== claimed.provenance.inputFingerprint
      )
        throw new Error("AI evaluation target changed during inference");
      const decision = saved.output.suggestions[snapshot.field];
      const model = snapshot.decisionModel;
      const entry = decision
        ? makeSweepSuggestion({
            currentValue: snapshot.currentValue,
            decision: {
              value: decision.value,
              confidence: decision.probability ?? 0,
            },
            model,
            pinnedModel: model,
          })
        : null;
      const applicationFailures: string[] = [];
      const outcome = await publishSweepSuggestions(
        tx,
        claimed.runId,
        {
          entity: snapshot.entity,
          field: snapshot.field,
          recordId: target.recordId,
          currentValue: snapshot.currentValue,
          fieldDecisionId: snapshot.fieldDecisionId,
          predecessorIds: target.suggestionIds,
          evaluationId: id,
          provenance: saved.provenance,
        },
        entry
          ? [
              {
                ...entry,
                model: saved.provenance.model ?? entry.model,
                status:
                  saved.provenance.model &&
                  saved.provenance.model !== snapshot.decisionModel
                    ? "pending"
                    : entry.status,
              },
            ]
          : [],
        decision?.financeReview?.fingerprint ?? null,
        kernel(tx, ports, claimed.runId),
        (error) => applicationFailures.push(scrubErrorMessage(String(error))),
      );
      return {
        outcome,
        applicationFailures,
        evaluatedOutcome: saved.output.outcomes?.[snapshot.field] ?? null,
      };
    });
  } catch (error) {
    const message = scrubErrorMessage(
      error instanceof Error ? error.message : String(error),
    );
    const obsolete =
      /obsolete|changed during inference|decided during inference|no longer exists/.test(
        message,
      );
    const admissionWait = message.includes("AI Gateway admission is waiting");
    await getDb(db)
      .update(aiEvaluation)
      .set({
        state: obsolete
          ? "obsolete"
          : !admissionWait && claimed.attempts >= 3
            ? "failed"
            : "retry_wait",
        attempts: admissionWait ? claimed.attempts - 1 : claimed.attempts,
        error: message,
        nextAttemptAt: new Date(
          Date.now() + 60_000 * Math.max(1, claimed.attempts),
        ),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(aiEvaluation.id, id),
          eq(aiEvaluation.attemptToken, token),
          inArray(aiEvaluation.state, ["running", "result_ready"]),
        ),
      );
  }
  return true;
}

export async function recoverAiRefresh(db: Database) {
  const { getAiRefreshEnabled } = await import("~/server/cf-env");
  const enabled = getAiRefreshEnabled();
  if (!enabled) return;
  const current = await readAiRefreshActivation(db);
  // Only deployment activation can change generations. An old Worker may still receive a cron.
  if (!current?.enabled || current.release !== __GIT_COMMIT__) return;
  const { reconcileWorkflowRuns } =
    await import("~/server/workflow-runs/lifecycle");
  await reconcileWorkflowRuns(db);
  const unfinished = await getDb(db)
    .select({ id: run.id })
    .from(run)
    .where(
      and(
        eq(run.purpose, "ai_refresh"),
        notDeleted(run),
        inArray(run.status, ["running", "failed"]),
        sql`${run.failureCode} IS DISTINCT FROM 'user_cancelled'`,
        sql`EXISTS (SELECT 1 FROM "AiEvaluation" AS eligible WHERE eligible."runId" = ${run.id} AND eligible.state IN (${aiEvaluationState.enum.queued}, ${aiEvaluationState.enum.running}, ${aiEvaluationState.enum.result_ready}, ${aiEvaluationState.enum.retry_wait}))`,
      ),
    )
    .limit(10);
  const { launchWorkflowRun } =
    await import("~/server/workflow-runs/lifecycle");
  const launch = async (ids: Iterable<string>) => {
    for (const id of ids) {
      try {
        const [row] = await getDb(db)
          .select()
          .from(run)
          .where(eq(run.id, runEntityId.parse(id)));
        if (
          !row ||
          (row.status === "running" &&
            Number(
              z.record(z.string(), z.unknown()).safeParse(row.progress).data
                ?.attempt ?? 0,
            ) > 0)
        )
          continue;
        const [runnable] = await getDb(db)
          .select({ id: aiEvaluation.id })
          .from(aiEvaluation)
          .where(
            and(
              eq(aiEvaluation.runId, runEntityId.parse(id)),
              inArray(aiEvaluation.state, [
                "queued",
                "running",
                "result_ready",
                "retry_wait",
              ]),
            ),
          )
          .limit(1);
        if (!runnable) continue;
        await launchWorkflowRun(db, {
          runId: runEntityId.parse(id),
          purpose: "ai_refresh",
        });
      } catch (error) {
        log.error("Refresh Workflow launch failed", {
          error: scrubErrorMessage(String(error)),
        });
      }
    }
  };
  await launch(unfinished.map((row) => row.id));
  await launch(await discoverAiRefresh(db));
}
