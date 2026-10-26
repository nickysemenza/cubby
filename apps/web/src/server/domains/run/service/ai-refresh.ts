import { fieldSuggestionsInput, fieldSuggestionsOut } from "@cubby/schemas/ai";
import {
  aiEvaluationTarget,
  aiProvenance,
  aiRefreshRunInput,
  aiRefreshActivation,
  type AiEvaluationTarget,
} from "@cubby/schemas/ai-evaluation";
import { buildActorContext } from "@cubby/schemas/context";
import { entityRefKey, type EntityRef } from "@cubby/schemas/entity";
import {
  basisValueOf,
  fieldSuggestionContextKeys,
  fieldSuggestionResolutionContext,
} from "@cubby/schemas/field-suggestion";
import {
  parseEntityRef,
  parseEntityId,
  runEntityId,
  userId,
} from "@cubby/schemas/identifiers";
import { EMAIL_RECLASSIFY_LIMIT } from "@cubby/schemas/mailbox-research";
import { supportedDecisionModelSchema } from "@cubby/shared/ai/models";
import { sha256Hex } from "@cubby/shared/sha256";
import { createLogger } from "@cubby/worker-tracing";
import { z } from "zod";

import { findErrorCause } from "~/lib/error-diagnostics";
import { scrubErrorMessage } from "~/lib/error-diagnostics";
import { AiBudgetExhaustedError } from "~/server/ai/budget";
import { aiWorkDeferral } from "~/server/ai/cooperative-work";
import { decisionCatalogRows } from "~/server/ai/decision-catalog";
import { settleDecisionWorkItems } from "~/server/ai/decision-model";
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
} from "~/server/ai/policy/refresh-manifest";
import {
  evaluateProductIdentity,
  prepareProductIdentityCatalog,
  evaluatePreparedProductIdentityPairs,
  evaluatePreparedProductIdentityPair,
  prepareProductIdentityPage,
  publishProductIdentityChunk,
  type PreparedProductIdentityPageOutcome,
} from "~/server/ai/product-identity";
import {
  claimAiEvaluation,
  publishAiEvaluation,
  publishAiEvaluationPage,
  publishAiEvaluationContinuation,
  failAiEvaluationPage,
  type EvaluationPageFailure,
} from "~/server/ai/repo/ai-evaluation";
import { enqueueAiEvaluations } from "~/server/ai/repo/ai-evaluation-requests";
import {
  readAiRefreshActivation,
  readAiDiscoveryCursor,
  saveAiDiscoveryCursor,
} from "~/server/ai/repo/ai-refresh";
import type {
  EvaluationPageAdapter,
  EvaluationPageTarget,
  EvaluationPagePreparation,
  EvaluationPageOutcome,
  EvaluationPagePublication,
} from "~/server/ai/repo/evaluation-page";
import type { AiRunContext } from "~/server/ai/run-feature";
import type { Database } from "~/server/db";
import { productIdentityEvidenceFences } from "~/server/domains/product/repo/match/product-identity-fence";
import { productIdentityEvidenceFence } from "~/server/domains/product/repo/match/product-identity-fence";
import {
  productIdentitySnapshot,
  productIdentitySnapshots,
  prepareProductIdentityPair,
  prepareProductIdentityPairRequests,
  preparedProductIdentityPair,
  productIdentityPairKey,
} from "~/server/domains/product/repo/match/product-identity-snapshot";
import type { PreparedProductPairPublication } from "~/server/domains/product/repo/match/product-match-candidate";
import {
  prepareProductPairPublication,
  prepareProductPairPublications,
  publishProductPairPublications,
} from "~/server/domains/product/repo/match/product-match-candidate";
import { executeEntity } from "~/server/entity-kernel";
import type { EntityKernelContext } from "~/server/entity-kernel/adapter";
import { entityCommandSchema } from "~/server/entity-kernel/contracts";
import { applyAutomaticRules } from "~/server/generic/assessment/repo/automatic-rule-runtime";
import {
  fieldCorrectionIdentity,
  fieldCorrectionRecipe,
  fieldReviewIdentity,
} from "~/server/generic/assessment/repo/field-assessment-review";
import { publishFieldCorrectionQuestion } from "~/server/generic/assessment/repo/field-correction-publication";
import {
  fieldInputFingerprint,
  fenceFieldInputsAtCommit,
  fieldInputFingerprintIfLive,
} from "~/server/generic/assessment/repo/field-input-fence";
import { latestFieldWrite } from "~/server/generic/audit-log/repo/field-write";
import { withJobExecution } from "~/server/generic/jobs/context";
import { currentJobExecution } from "~/server/generic/jobs/context";
import { JobDeferredError } from "~/server/generic/jobs/errors";
import { lookupShortcodes } from "~/server/generic/shortcode/repo/shortcode-resolver";
import { buildCrudServices } from "~/server/http/request-context";
import { canonicalJson } from "~/server/lib/canonical-json";
import { TraceNames, withTrace } from "~/server/observability/tracing";
import { withWorkflowExecution } from "~/server/workflows/runs/execution";

import { checkConnectionSourceBeforeCommit } from "../repo/ai-refresh-state";
import {
  assessmentStatesById,
  emailClassificationObservations,
  fieldRefreshHistory,
  liveProductIdsAfter,
  pendingFieldRefreshes,
  recordAiRefreshAttemptFailure,
  scheduleEvaluationRun,
  settleAppliedFieldRefresh,
  uncertainEmailRefreshCandidates,
  type FieldRefreshCursor,
} from "../repo/ai-refresh-state";
import {
  guardAiEvaluationAttempt,
  storeAiEvaluationResult,
} from "../repo/ai-work-state";
import {
  connectionSourceFingerprint,
  connectionSourceFingerprintsOrMissing,
  countConnectionSweepSources,
} from "../repo/connection-refresh";
import { systemActor } from "../repo/ensure-run";
import {
  makeSweepSuggestion,
  publishSweepSuggestions,
} from "./suggestion-sweep";

const log = createLogger("ai-refresh");

/** Connection units per publication transaction; see the publication loop. */
const CONNECTION_UNITS_PER_TRANSACTION = 2;

export type AiRefreshPorts = {
  context?: EntityKernelContext;
  suggestPorts?: SuggestFieldsPorts;
  productIdentityPorts?: Parameters<typeof evaluateProductIdentity>[3];
  emailPorts?: Pick<
    Parameters<
      typeof import("~/server/domains/purchase-import/service/gmail/ingest").ingestGmailMessages
    >[2],
    "triage" | "relevance" | "storage"
  >;
  /** Test seam: the Automatic rule audit sample, so outcomes never ride on random ids. */
};
const jsonSnapshot = (value: unknown) =>
  z.json().parse(JSON.parse(JSON.stringify(value)));
const fieldSnapshot = z.object({
  publicId: z.string(),
  entity: fieldSuggestionsInput.shape.entity,
  field: z.string(),
  currentValue: z.json(),
  fieldDecisionId: z.uuid().nullable().default(null),
  decisionModelOverride: supportedDecisionModelSchema.optional(),
  basis: z.record(z.string(), z.string().nullable()),
});
const fieldResult = z.object({
  reviewKey: z.string().nullable().optional(),
  correctionKey: z.string().nullable().optional(),
  correctionRecipe: fieldCorrectionRecipe.optional(),
  output: fieldSuggestionsOut,
  provenance: aiProvenance,
});

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
    fieldSuggestionContextKeys(entity, [
      ...policy.basis.map((row) => row.key),
      target.field,
    ]).map((key) => [key, basisValueOf(record[key])]),
  );
  basis.__resolutionContext = fieldSuggestionResolutionContext(
    record.fieldResolutions,
    [...policy.basis.map((row) => row.key), target.field],
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
    decisionModelOverride: ports.suggestPorts?.decisionModel,
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
        recordId: target.recordId,
        decisionModel: snapshot.decisionModelOverride,
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

/** An old Worker must not enqueue or recover work for another executable policy. */
async function currentAiRefreshActivation(db: Database) {
  const current = await readAiRefreshActivation(db);
  if (!current?.enabled) return null;
  const compiled = await compiledRefreshManifest();
  if (
    Object.keys(current.manifest).length !== Object.keys(compiled).length ||
    Object.entries(compiled).some(
      ([feature, policy]) =>
        current.manifest[feature]?.promptVersion !== policy.promptVersion ||
        current.manifest[feature]?.policyFingerprint !==
          policy.policyFingerprint,
    )
  )
    return null;
  return current;
}

/** Live saved-record questions enqueue the same canonical work as discovery.
 * Client draft basis and the inactive interactive prediction never authorize writes.
 */
export async function scheduleSavedFieldQuestion(
  db: Database,
  target: Extract<AiEvaluationTarget, { kind: "field" }>,
  ports: AiRefreshPorts = {},
) {
  const activation = await currentAiRefreshActivation(db);
  if (!activation) return;
  const prepared = await prepareField(db, target, ports);
  if (
    !prepared ||
    (prepared.snapshot.currentValue !== null &&
      prepared.snapshot.currentValue !== "")
  )
    return;
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
  const result = await scheduleEvaluationRun(
    db,
    systemActor(),
    {
      purpose: "ai_refresh",
      trigger: "scheduled",
      status: "running",
      clientKey: `ai-refresh:field:${key}`,
      input: aiRefreshRunInput.parse({ kind: "ai_refresh", activation }),
    },
    [{ target, provenance: prepared.provenance, snapshot: prepared.snapshot }],
  );
  if (result.kind === "deferred")
    log.info("Saved field evaluation scheduling deferred", {
      reason: result.reason,
      entity: target.entity,
      recordId: target.recordId,
      field: target.field,
    });
}

async function scheduleProductIdentityDiscovery(
  db: Database,
  activation: z.infer<typeof aiRefreshActivation>,
  cursor: Awaited<ReturnType<typeof readAiDiscoveryCursor>>,
  ports: AiRefreshPorts,
) {
  const scheduledRuns = new Set<string>();
  let deferred = false;
  const products = cursor.productDone
    ? []
    : await liveProductIdsAfter(db, cursor.product, EMAIL_RECLASSIFY_LIMIT);
  const snapshots = await productIdentitySnapshots(
    db,
    products.map((item) => item.id),
  );
  const targets = products.flatMap((item) => {
    const prepared = snapshots.get(item.id);
    if (!prepared) return [];
    return [
      {
        target: aiEvaluationTarget.parse({
          kind: "product",
          entity: "product",
          recordId: item.id,
          field: null,
          assessmentIds: [],
        }),
        provenance: aiProvenance.parse({
          dependencies: dependencyStamps(activation.manifest, [
            "product-identity",
          ]),
          inputFingerprint: prepared.fingerprint,
          optionFingerprint: "canonical-product-pairs-v1",
          model: null,
        }),
        snapshot: prepared.snapshot,
      },
    ];
  });
  if (targets.length) {
    const key = await sha256Hex(
      JSON.stringify(
        targets.map((entry) => [entry.target.recordId, entry.provenance]),
      ),
    );
    const productRun = await scheduleEvaluationRun(
      db,
      ports.context?.actorContext ?? systemActor(),
      {
        purpose: "ai_refresh",
        trigger: "scheduled",
        status: "running",
        clientKey: `ai-refresh:product-page:${key}`,
        input: aiRefreshRunInput.parse({ kind: "ai_refresh", activation }),
      },
      targets,
    );
    if (productRun.kind === "scheduled") scheduledRuns.add(productRun.runId);
    deferred = productRun.kind === "deferred";
  }
  return {
    runs: [...scheduledRuns],
    deferred,
    productDone:
      !deferred &&
      (cursor.productDone || products.length < EMAIL_RECLASSIFY_LIMIT),
    product: deferred
      ? cursor.product
      : products.length === EMAIL_RECLASSIFY_LIMIT
        ? products.at(-1)!.id
        : null,
  };
}

const fieldCursorFor = (pending: readonly FieldRefreshCursor[]) =>
  pending.length === EMAIL_RECLASSIFY_LIMIT ? (pending.at(-1) ?? null) : null;
const emailCursorFor = (rows: readonly { item: { id: string } }[]) =>
  rows.length === EMAIL_RECLASSIFY_LIMIT * 2 ? rows.at(-1)!.item.id : null;

/**
 * Connection coverage is one routine Sweep per discovery generation: a
 * visible Run with its own step, instead of one Run per record. Sources
 * already evaluated under their current fingerprint are skipped by it.
 */
async function scheduleConnectionDiscovery(
  db: Database,
  cursor: Awaited<ReturnType<typeof readAiDiscoveryCursor>>,
) {
  if (cursor.connectionDone || !(await countConnectionSweepSources(db)))
    return { done: true, cursor: null };
  try {
    const { startRoutineSweep } = await import("./sweep");
    await startRoutineSweep(db, "recommendation");
  } catch (error) {
    // Still done: a pending connection pass would hold the generation open
    // and stall field and product rediscovery. The next generation retries.
    log.error("Connection discovery Sweep failed to start", {
      error: scrubErrorMessage(String(error)),
    });
  }
  return { done: true, cursor: null };
}

/** Preparation enumerates evidence using live renderers; no model calls happen here. */
// oxlint-disable-next-line complexity -- Independent discovery streams checkpoint their capacity deferrals together.
export async function discoverAiRefresh(
  db: Database,
  ports: AiRefreshPorts = {},
) {
  const activation = await readAiRefreshActivation(db);
  if (!activation?.enabled)
    return { runs: [], deferred: false, complete: true };
  const runs = new Set<string>();
  let cursor = await readAiDiscoveryCursor(db);
  if (
    cursor.revision !== activation.revision ||
    (cursor.fieldDone &&
      cursor.emailDone &&
      cursor.productDone &&
      cursor.connectionDone)
  )
    cursor = {
      revision: activation.revision,
      field: null,
      email: null,
      fieldDone: false,
      emailDone: false,
      productDone: false,
      product: null,
      connectionDone: false,
      connection: null,
    };
  const pending = cursor.fieldDone
    ? []
    : await pendingFieldRefreshes(db, cursor.field, EMAIL_RECLASSIFY_LIMIT);
  const grouped = new Map<string, typeof pending>();
  let fieldDeferred = false;
  let emailDeferred = false;
  for (const row of pending) {
    const history = await fieldRefreshHistory(db, row);
    grouped.set(`${row.entity}:${row.recordId}:${row.field}`, history);
  }
  for (const rows of grouped.values()) {
    try {
      // Current pending advice is reconsidered even when its inference inputs
      // have not changed. Applied/rejected rows cannot re-enter this path.
      const pendingIds = rows
        .filter((row) => row.status === "pending")
        .map((row) => row.id);
      const automatic = await applyAutomaticRules(db, pendingIds, {
        context: ports.context,
      });
      if (automatic.applied.length) continue;
      const first = rows[0]!;
      const target = aiEvaluationTarget.parse({
        kind: "field",
        entity: first.entity,
        recordId: first.recordId,
        field: first.field,
        assessmentIds: rows.map((row) => row.id),
      });
      if (target.kind !== "field") continue;
      const applied =
        first.status === "applied" || first.acceptanceReceipt !== null;
      const currentFingerprint = applied
        ? await fieldInputFingerprintIfLive(
            db,
            target.entity,
            target.recordId,
            target.field,
          )
        : null;
      if (applied && currentFingerprint === null) continue;
      const evaluated = first.acceptanceReceipt?.evaluatedInput;
      if (
        applied &&
        evaluated &&
        dependenciesCurrent(evaluated.provenance, activation.manifest) &&
        evaluated.fingerprint === currentFingerprint
      )
        continue;
      // Applications retain history rather than protecting the old author's
      // value. Skip only the exact evidence settled by this application.
      if (
        applied &&
        first.provenance &&
        dependenciesCurrent(first.provenance, activation.manifest) &&
        first.acceptanceReceipt?.appliedInputFingerprint &&
        first.acceptanceReceipt.appliedInputFingerprint === currentFingerprint
      )
        continue;
      const prepared = await prepareField(db, target, ports);
      if (
        !prepared ||
        (!applied &&
          prepared.lastWrite &&
          prepared.lastWrite.createdAt > first.createdAt)
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
        !applied &&
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
      if (runId.kind === "scheduled") runs.add(runId.runId);
      if (runId.kind === "deferred") {
        fieldDeferred = true;
        break;
      }
    } catch (error) {
      log.error("Field refresh discovery failed", {
        error: scrubErrorMessage(String(error)),
      });
    }
  }
  const candidates = cursor.emailDone
    ? []
    : await uncertainEmailRefreshCandidates(
        db,
        cursor.email,
        EMAIL_RECLASSIFY_LIMIT * 2,
      );
  const observations = await emailClassificationObservations(
    db,
    candidates.map(({ item }) => item.id),
  );
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
  emailGroups: for (const group of mailboxes.values())
    for (let start = 0; start < group.length; start += EMAIL_RECLASSIFY_LIMIT) {
      try {
        const batch = group.slice(start, start + EMAIL_RECLASSIFY_LIMIT);
        const first = batch[0]!;
        if (!first.ownerUserId) continue;
        const { mailImportEnabled } =
          await import("~/server/domains/purchase-import/repo/mail-import-settings");
        const authorizationError = (await mailImportEnabled(
          db,
          first.item.mailboxId,
        ))
          ? undefined
          : "Mail import is off for this mailbox.";
        const dependencies = dependencyStamps(activation.manifest, [
          "mailbox-triage",
          "mailbox-relevance",
        ]);
        const key = await sha256Hex(
          JSON.stringify({
            dependencies,
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
              assessmentIds: [],
            }),
            provenance: aiProvenance.parse({
              dependencies,
              inputFingerprint: await sha256Hex(
                JSON.stringify({
                  checksum: item.checksum,
                  contentClearedAt: item.contentClearedAt,
                  orderMailId: item.orderMailId,
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
          buildActorContext(userId.parse(first.ownerUserId), "system"),
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
              mailboxId: first.item.mailboxId,
              emails: batch.map(({ item }) => ({
                emailId: item.id,
                checksum: item.checksum,
              })),
            }),
          },
          targets,
        );
        if (runId.kind === "scheduled") runs.add(runId.runId);
        if (runId.kind === "deferred") {
          emailDeferred = true;
          break emailGroups;
        }
      } catch (error) {
        log.error("Email refresh discovery failed", {
          error: scrubErrorMessage(String(error)),
        });
      }
    }
  const productDiscovery = await scheduleProductIdentityDiscovery(
    db,
    activation,
    cursor,
    ports,
  );
  for (const productRun of productDiscovery.runs) runs.add(productRun);
  const connectionDiscovery = await scheduleConnectionDiscovery(db, cursor);
  const nextCursor = {
    revision: activation.revision,
    productDone: productDiscovery.productDone,
    product: productDiscovery.product,
    fieldDone:
      !fieldDeferred &&
      (cursor.fieldDone || pending.length < EMAIL_RECLASSIFY_LIMIT),
    emailDone:
      !emailDeferred &&
      (cursor.emailDone || candidates.length < EMAIL_RECLASSIFY_LIMIT * 2),
    field: fieldDeferred ? cursor.field : fieldCursorFor(pending),
    email: emailDeferred ? cursor.email : emailCursorFor(candidates),
    connectionDone: connectionDiscovery.done,
    connection: connectionDiscovery.cursor,
  };
  await saveAiDiscoveryCursor(db, nextCursor);
  return {
    runs: [...runs],
    deferred: fieldDeferred || emailDeferred || productDiscovery.deferred,
    complete:
      nextCursor.fieldDone &&
      nextCursor.emailDone &&
      nextCursor.productDone &&
      nextCursor.connectionDone,
  };
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
    await guardAiEvaluationAttempt(db, id, token);
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
    if (target.kind === "connection") {
      const { entityGraphRootSchema } =
        await import("@cubby/schemas/entity-graph");
      const source = entityGraphRootSchema.parse(claimed.snapshot);
      if (
        source.entityKind !== target.entity ||
        (await connectionSourceFingerprint(db, source)) !==
          claimed.provenance.inputFingerprint
      )
        throw new Error(
          "Connection discovery source changed before evaluation",
        );
      const { prepareEntityConnections } =
        await import("~/server/domains/connection/service/entity-connections");
      const preparation = await prepareEntityConnections(
        db,
        kernel(db, ports, claimed.runId),
        source,
        {
          suggestPorts: ports.suggestPorts,
          productIdentityPorts: ports.productIdentityPorts,
        },
      );
      const fenceSource = (transactionDb: Database) =>
        checkConnectionSourceBeforeCommit(
          transactionDb,
          () => connectionSourceFingerprint(transactionDb, source),
          claimed.provenance.inputFingerprint,
        );
      // Units publish a few per transaction: each transaction's guard and
      // fences cost about ten statements, while one transaction over every
      // unit held activation and a pooled connection for 100+ statements (#2819).
      const { publishPreparedEntityConnections } =
        await import("~/server/domains/connection/repo/entity-connections");
      const units = [
        ...Array.from(
          { length: Math.ceil(preparation.connections.length / 16) },
          (_, index) => async (tx: Database) => {
            await publishPreparedEntityConnections(
              tx,
              preparation.connections.slice(index * 16, index * 16 + 16),
            );
          },
        ),
        ...Array.from(
          { length: Math.ceil(preparation.productPairs.length / 16) },
          (_, index) => async (tx: Database) => {
            const results = await publishProductPairPublications(
              tx,
              preparation.productPairs.slice(index * 16, index * 16 + 16),
            );
            if (results.some((result) => !result.valid))
              throw new Error("Product pair evidence changed during inference");
          },
        ),
        ...preparation.publications,
      ];
      for (
        let offset = 0;
        offset < units.length;
        offset += CONNECTION_UNITS_PER_TRANSACTION
      ) {
        const chunk = units.slice(
          offset,
          offset + CONNECTION_UNITS_PER_TRANSACTION,
        );
        await withTrace(
          TraceNames.service("connections", "publish"),
          () =>
            publishAiEvaluation(
              db,
              id,
              token,
              async (transactionDb) => {
                for (const publish of chunk) await publish(transactionDb);
                await fenceSource(transactionDb);
                return null;
              },
              "continue",
            ),
          {
            "connection.publication": offset,
            "connection.units": chunk.length,
          },
        );
      }
      await publishAiEvaluation(db, id, token, async (transactionDb) => {
        if (!preparation.complete)
          throw new Error(
            `Connection candidate coverage is unconfirmed. ${preparation.coverageErrors.join("\n")}`,
          );
        await fenceSource(transactionDb);
        return { source, discovered: true };
      });
      return true;
    }
    if (target.kind === "email") {
      const { refreshEmailEvaluation } =
        await import("~/server/domains/purchase-import/service/gmail/refresh-evaluation");
      await refreshEmailEvaluation(db, claimed, ports.emailPorts);
      return true;
    }
    if (target.kind === "product_pair") {
      const prepared = preparedProductIdentityPair.parse(claimed.snapshot);
      const current = await prepareProductIdentityPair(db, [
        parseEntityId("product", target.recordId),
        parseEntityId("product", target.otherId),
      ]);
      if (
        !current ||
        current.fingerprint !== claimed.provenance.inputFingerprint
      )
        throw new Error("Product pair evidence changed during inference");
      const result = await evaluatePreparedProductIdentityPair(
        db,
        prepared,
        claimed.runId,
        {
          ...ports.productIdentityPorts,
          evaluationId: id,
          provenance: claimed.provenance,
        },
      );
      const publish = await prepareProductPairPublication(db, result);
      await publishAiEvaluation(db, id, token, async (transactionDb) => {
        await publish(transactionDb);
        return {
          pair: prepared.productIds,
          fingerprint: prepared.fingerprint,
          model: result.producer.model,
          actionable: result.actionable,
          conflict: result.conflict,
        };
      });
      return true;
    }
    if (target.kind === "product") {
      const productId = parseEntityId("product", target.recordId);
      const source = await productIdentitySnapshot(db, productId);
      if (!source || source.fingerprint !== claimed.provenance.inputFingerprint)
        throw new Error("AI evaluation target changed during inference");
      const prepared = await prepareProductIdentityCatalog(db, productId);
      const exactResults = new Map<
        string,
        Awaited<ReturnType<typeof evaluatePreparedProductIdentityPair>>
      >();
      const exactPairs = prepared.pairs.filter((pair) => pair.exact);
      const settled = await evaluatePreparedProductIdentityPairs(
        db,
        exactPairs,
        claimed.runId,
        {
          ...ports.productIdentityPorts,
          evaluationId: id,
          provenance: claimed.provenance,
        },
      );
      for (const [index, result] of settled.entries()) {
        if (result.status === "rejected") throw result.reason;
        exactResults.set(exactPairs[index]!.fingerprint, result.value);
      }
      let rulePairs = 0,
        requestedPairs = 0;
      // Bound evidence preparation while retaining each pair's short, fenced commit.
      const batchSize = 16;
      for (
        let offset = 0;
        offset < prepared.pairs.length;
        offset += batchSize
      ) {
        const batch = prepared.pairs.slice(offset, offset + batchSize);
        const rules = batch.flatMap((pair) => {
          const result = exactResults.get(pair.fingerprint);
          if (pair.exact && !result)
            throw new Error(
              "Prepared exact Product identity result is missing",
            );
          return result ? [result] : [];
        });
        const preparedRules = await prepareProductPairPublications(
          db,
          rules.map((input, index) => ({ key: String(index), input })),
        );
        if (preparedRules.length !== rules.length)
          throw new Error("Product pair evidence changed during inference");
        const rulePublications = preparedRules.map(
          (prepared) => async (transactionDb: Database) => {
            const [result] = await publishProductPairPublications(
              transactionDb,
              [prepared],
            );
            if (!result?.valid)
              throw new Error("Product pair evidence changed during inference");
            return result.row;
          },
        );
        const requests = await prepareProductIdentityPairRequests(
          db,
          batch.filter((pair) => !pair.exact),
          claimed.runId,
          claimed.provenance,
        );
        let ruleIndex = 0,
          requestIndex = 0;
        for (const pair of batch) {
          const publish = pair.exact
            ? rulePublications[ruleIndex++]!
            : requests[requestIndex++]!;
          await publishAiEvaluation(
            db,
            id,
            token,
            async (transactionDb) => {
              await publish(transactionDb);
              return null;
            },
            "continue",
          );
          if (pair.exact) rulePairs++;
          else requestedPairs++;
        }
      }
      const sourceFence = await productIdentityEvidenceFence(db, [productId]);
      const latest = await productIdentitySnapshot(db, productId);
      if (
        !latest ||
        latest.fingerprint !== source.fingerprint ||
        (await productIdentityEvidenceFence(db, [productId])) !== sourceFence
      )
        throw new Error("Product identity evidence changed during inference");
      await publishAiEvaluation(db, id, token, async (transactionDb) => {
        if (
          (await productIdentityEvidenceFence(transactionDb, [productId])) !==
          sourceFence
        )
          throw new Error("Product identity evidence changed during inference");
        return {
          eligible: prepared.eligible,
          excluded: !prepared.eligible ? "misc_or_deleted" : null,
          rulePairs,
          requestedPairs,
          catalogEnumeration: true,
          coverage: prepared.coverage,
        };
      });
      return true;
    }
    const snapshot = fieldSnapshot.parse(claimed.snapshot);
    const fieldPorts = {
      ...ports,
      suggestPorts: {
        ...ports.suggestPorts,
        decisionModel: snapshot.decisionModelOverride,
      },
    };
    const prepared = await prepareField(db, target, fieldPorts);
    if (
      !prepared ||
      prepared.provenance.inputFingerprint !==
        claimed.provenance.inputFingerprint
    )
      throw new Error("AI evaluation target changed during inference");
    const previous = await assessmentStatesById(db, target.assessmentIds);
    if (
      previous.length !== target.assessmentIds.length ||
      previous.some(
        (row) =>
          row.acceptanceReceipt === null &&
          !["pending", "superseded", "applied"].includes(row.status),
      )
    )
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
          { ...fieldPorts.suggestPorts, recordId: target.recordId },
        ),
      );
      const provenance = {
        ...prepared.provenance,
        model:
          evaluated.result.outcomes?.[snapshot.field]?.kind === "correction"
            ? null
            : ([...evaluated.inputs]
                .reverse()
                .find(
                  (call) =>
                    call.operation ===
                    `suggestFields.${snapshot.entity}.${snapshot.field}`,
                )?.model ??
              snapshot.decisionModelOverride ??
              null),
      };
      const reviewKey = await fieldReviewIdentity({
        entity: snapshot.entity,
        recordId: target.recordId,
        field: snapshot.field,
        currentValue: snapshot.currentValue,
        proposal: evaluated.result.suggestions[snapshot.field],
        model: provenance.model,
        inputs: evaluated.inputs,
        dependencies: provenance.dependencies,
      });
      result = fieldResult.safeParse({
        output: evaluated.result,
        provenance,
        reviewKey,
        correctionRecipe: evaluated.incomplete
          ? undefined
          : {
              version: "field-correction-v2",
              entity: snapshot.entity,
              field: snapshot.field,
              basis: snapshot.basis,
              inputs: evaluated.inputs,
              dependencies: provenance.dependencies,
            },
        correctionKey: await fieldCorrectionIdentity({
          entity: snapshot.entity,
          field: snapshot.field,
          basis: snapshot.basis,
          inputs: evaluated.inputs,
          dependencies: provenance.dependencies,
          incomplete: evaluated.incomplete,
        }),
      });
      if (!result.success) throw result.error;
      if (
        !(await storeAiEvaluationResult(
          db,
          { id, attemptToken: token },
          jsonSnapshot(result.data),
        ))
      )
        throw new Error("AI evaluation attempt is obsolete");
    }
    const saved = result.data;
    await publishAiEvaluation(db, id, token, async (tx) => {
      const now = await prepareField(tx, target, fieldPorts);
      if (
        !now ||
        now.provenance.inputFingerprint !== claimed.provenance.inputFingerprint
      )
        throw new Error("AI evaluation target changed during inference");
      const decision = saved.output.suggestions[snapshot.field];
      const correctionOutcome = saved.output.outcomes?.[snapshot.field];
      if (correctionOutcome?.kind === "correction") {
        await publishFieldCorrectionQuestion(tx, {
          entity: snapshot.entity,
          recordId: target.recordId,
          field: snapshot.field,
          currentValue: snapshot.currentValue,
          outcome: correctionOutcome,
          correctionRecipe: saved.correctionRecipe,
          provenance: saved.provenance,
          runId: claimed.runId,
        });
        return {
          outcome: "queued",
          applicationFailures: [],
          evaluatedOutcome: correctionOutcome,
        };
      }
      const model =
        saved.provenance.model ?? snapshot.decisionModelOverride ?? "unknown";
      const entry = decision
        ? makeSweepSuggestion({
            currentValue: snapshot.currentValue,
            decision: {
              value: decision.value,
              confidence: decision.probability ?? 0,
            },
            model,
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
          predecessorIds: target.assessmentIds,
          evaluationId: id,
          provenance: saved.provenance,
        },
        entry
          ? [
              {
                ...entry,
                reviewKey: saved.reviewKey,
                correctionKey: saved.correctionKey,
                correctionRecipe: saved.correctionRecipe,
                model: saved.provenance.model ?? entry.model,
              },
            ]
          : [],
        decision?.financeReview?.fingerprint ?? null,
        kernel(tx, ports, claimed.runId),
        (error) => applicationFailures.push(scrubErrorMessage(String(error))),
      );
      const [predecessorId] = target.assessmentIds;
      if (outcome === "settled" && predecessorId) {
        await settleAppliedFieldRefresh(
          tx,
          predecessorId,
          await fieldInputFingerprint(
            tx,
            target.entity,
            target.recordId,
            target.field,
          ),
          saved.provenance,
        );
        await fenceFieldInputsAtCommit(
          tx,
          target.entity,
          target.recordId,
          target.field,
        );
      }
      return {
        outcome,
        applicationFailures,
        evaluatedOutcome: saved.output.outcomes?.[snapshot.field] ?? null,
      };
    });
  } catch (error) {
    const deferred = findErrorCause(
      error,
      (cause): cause is JobDeferredError => cause instanceof JobDeferredError,
    );
    if (deferred) throw deferred;
    const message = scrubErrorMessage(
      error instanceof Error ? error.message : String(error),
    );
    // A changed connection source has a new fingerprint and so a new work key;
    // discovery re-admits it (possibly after its pending backlog drains), so
    // retrying this attempt against the old fingerprint can never succeed.
    // Candidate-side evidence changes keep retrying: they do not re-admit
    // this source.
    const obsolete =
      /obsolete|changed during inference|decided during inference|no longer exists|Connection (discovery )?source changed/.test(
        message,
      );
    const admissionWait = message.includes("AI Gateway admission is waiting");
    await recordAiRefreshAttemptFailure(db, id, token, {
      state: obsolete
        ? "obsolete"
        : !admissionWait &&
            claimed.attempts >= (currentJobExecution()?.claim.maxAttempts ?? 3)
          ? "failed"
          : "retry_wait",
      error: message,
    });
    if (admissionWait)
      throw new JobDeferredError(
        message,
        new Date(Date.now() + 30_000),
        "rate_limit",
      );
    if (!obsolete) throw error;
  }
  return true;
}

type ProductPagePreparation = PreparedProductIdentityPageOutcome & {
  enrollment: { rulePairs: number; requestedPairs: number } | null;
};

type ProductPageOutcome =
  | {
      kind: "pair";
      publication: PreparedProductPairPublication;
      receipt: z.infer<ReturnType<typeof z.json>>;
    }
  | {
      kind: "catalog";
      preparation: PreparedProductIdentityPageOutcome;
      receipt: z.infer<ReturnType<typeof z.json>>;
    };

function inEvaluationContext<T>(
  db: Database,
  target: EvaluationPageTarget,
  work: () => Promise<T>,
): Promise<T> {
  return withJobExecution(db, target.claim, () =>
    withWorkflowExecution(
      {
        runId: target.evaluation.runId,
        attempt: target.claim.generation,
        database: db,
      },
      work,
    ),
  );
}

/** Product preparation and publication stay set-based behind the stable page contract. */
function productEvaluationPageAdapter(
  ports: AiRefreshPorts = {},
): EvaluationPageAdapter<ProductPagePreparation, ProductPageOutcome> {
  return {
    operation: "product-identity",
    async prepare(db, targets) {
      const byId = new Map(
        targets.map((entry) => [entry.evaluation.id, entry]),
      );
      const prepared = await prepareProductIdentityPage(
        db,
        targets.map((entry) => {
          const target = entry.target;
          if (target.kind !== "product" && target.kind !== "product_pair")
            throw new Error("Unsupported Product page target");
          return target.kind === "product"
            ? {
                key: entry.evaluation.id,
                kind: target.kind,
                recordId: parseEntityId("product", target.recordId),
              }
            : {
                key: entry.evaluation.id,
                kind: target.kind,
                recordId: parseEntityId("product", target.recordId),
                otherId: parseEntityId("product", target.otherId),
              };
        }),
      );
      // Lane B returns source snapshots on candidate pairs. Sources without
      // candidates need one additional set read to preserve their queued input hash.
      const empty = prepared.filter(
        (entry) => entry.productIds.length === 1 && !entry.pairs.length,
      );
      const emptySnapshots = await productIdentitySnapshots(
        db,
        empty.map((entry) => entry.productIds[0]),
      );
      const emptyFences = empty.length
        ? await productIdentityEvidenceFences(
            db,
            empty.map((entry) => ({
              key: entry.key,
              productIds: entry.productIds,
            })),
          )
        : new Map<string, string>();
      return Promise.all(
        prepared.map(
          async (
            entry,
          ): Promise<EvaluationPagePreparation<ProductPagePreparation>> => {
            const target = byId.get(entry.key);
            if (!target)
              throw new Error(
                "Product preparation returned an unexpected target",
              );
            try {
              if (
                !entry.valid ||
                (emptyFences.has(entry.key) &&
                  emptyFences.get(entry.key) !== entry.fence)
              )
                throw new Error(
                  "Product identity evidence changed during inference",
                );
              if (target.target.kind === "product_pair") {
                const current = entry.pairs[0];
                const frozen = preparedProductIdentityPair.parse(
                  target.evaluation.snapshot,
                );
                if (
                  !current ||
                  current.fingerprint !==
                    target.evaluation.provenance.inputFingerprint ||
                  frozen.fingerprint !== current.fingerprint
                )
                  throw new Error(
                    "Product pair evidence changed during inference",
                  );
                // Persisted JSONB ordering is part of the existing standalone question.
                entry = {
                  ...entry,
                  pairs: [
                    { ...current, first: frozen.first, second: frozen.second },
                  ],
                };
              } else {
                const pair = entry.pairs[0];
                const source = pair
                  ? pair.productIds[0] === target.target.recordId
                    ? pair.first
                    : pair.second
                  : emptySnapshots.get(entry.productIds[0])?.snapshot;
                const fingerprint =
                  source === undefined
                    ? null
                    : await sha256Hex(canonicalJson(source));
                if (
                  fingerprint !== target.evaluation.provenance.inputFingerprint
                )
                  throw new Error(
                    "AI evaluation target changed during inference",
                  );
              }
              return {
                kind: "ready",
                target,
                evidenceDigest: entry.fence,
                prepared: { ...entry, enrollment: null },
              };
            } catch (error) {
              return {
                kind: "failed",
                target,
                error:
                  error instanceof Error ? error : new Error(String(error)),
              };
            }
          },
        ),
      );
    },
    async evaluate(db, entry, usage) {
      const item = entry.target.evaluation;
      const prepared = entry.prepared;
      const evaluate = (pair: z.infer<typeof preparedProductIdentityPair>) =>
        evaluatePreparedProductIdentityPair(db, pair, item.runId, {
          ...ports.productIdentityPorts,
          usage,
          evaluationId: item.id,
          provenance: item.provenance,
          preparedPage: true,
        });
      if (entry.target.target.kind === "product_pair") {
        const pair = prepared.pairs[0]!;
        const result = await evaluate(pair);
        return {
          kind: "pair",
          publication: {
            key: item.id,
            input: result,
            pair,
            fence:
              prepared.pairFences.get(
                productIdentityPairKey(pair.productIds),
              ) ?? "",
          },
          receipt: {
            pair: pair.productIds,
            fingerprint: pair.fingerprint,
            model: result.producer.model,
            actionable: result.actionable,
            conflict: result.conflict,
          },
        };
      }
      if (prepared.enrollment)
        return {
          kind: "catalog",
          preparation: prepared,
          receipt: jsonSnapshot({
            eligible: prepared.eligible,
            excluded: !prepared.eligible ? "misc_or_deleted" : null,
            ...prepared.enrollment,
            catalogEnumeration: true,
            coverage: prepared.coverage,
          }),
        };
      throw new Error(
        "Product source enrollment must precede its enumeration receipt",
      );
    },
    async publish(tx, outcomes) {
      const pairs = outcomes.flatMap((entry) =>
        entry.outcome.kind === "pair" ? [entry.outcome.publication] : [],
      );
      const published = pairs.length
        ? await publishProductIdentityChunk(tx, pairs)
        : [];
      const validity = new Map(
        published.map((entry) => [entry.key, entry.valid]),
      );
      const sources = outcomes.flatMap((entry) =>
        entry.outcome.kind === "catalog"
          ? [
              {
                key: entry.target.evaluation.id,
                productIds: entry.outcome.preparation.productIds,
              },
            ]
          : [],
      );
      const fences = await productIdentityEvidenceFences(tx, sources);
      return outcomes.map((entry) => {
        const valid =
          entry.outcome.kind === "pair"
            ? validity.get(entry.target.evaluation.id) === true
            : fences.get(entry.target.evaluation.id) === entry.evidenceDigest;
        return {
          evaluationId: entry.target.evaluation.id,
          state: valid ? ("completed" as const) : ("obsolete" as const),
          receipt: valid
            ? entry.outcome.receipt
            : { reason: "Product identity evidence changed during inference" },
        };
      });
    },
  };
}

function pageFailure(
  target: EvaluationPageTarget,
  error: unknown,
): EvaluationPageFailure {
  const deferred = findErrorCause(
    error,
    (cause): cause is JobDeferredError => cause instanceof JobDeferredError,
  );
  const budget = findErrorCause(
    error,
    (cause): cause is AiBudgetExhaustedError =>
      cause instanceof AiBudgetExhaustedError,
  );
  const capacity = aiWorkDeferral(error);
  const message = scrubErrorMessage(
    error instanceof Error ? error.message : String(error),
  );
  const obsolete =
    /obsolete|changed during inference|changed during evaluation|decided during inference|no longer exists/.test(
      message,
    );
  const admission = message.includes("AI Gateway admission is waiting");
  const wait = deferred
    ? { until: deferred.until, reason: deferred.reason }
    : budget
      ? {
          until: new Date(budget.resumeAt),
          reason: "ai_funding_window" as const,
        }
      : capacity
        ? {
            until: new Date(capacity.until),
            reason: "provider_capacity" as const,
          }
        : admission
          ? {
              until: new Date(Date.now() + 30_000),
              reason: "rate_limit" as const,
            }
          : undefined;
  return {
    target,
    state: obsolete
      ? "obsolete"
      : !wait && target.claim.attempts >= target.claim.maxAttempts
        ? "failed"
        : "retry_wait",
    error: message,
    ...(wait ? { wait } : {}),
  };
}

/** A finite decision scope; each continuation captures its own target authority. */
export async function executeAiRefreshPage<P, O>(
  db: Database,
  targets: readonly EvaluationPageTarget[],
  adapter: EvaluationPageAdapter<P, O>,
  stage?: (
    db: Database,
    ready: readonly Extract<EvaluationPagePreparation<P>, { kind: "ready" }>[],
  ) => Promise<EvaluationPagePreparation<P>[]>,
) {
  const compiled = await compiledRefreshManifest();
  const compatible = targets.filter((entry) =>
    dependenciesCurrent(
      {
        ...entry.evaluation.provenance,
        dependencies: entry.evaluation.provenance.dependencies.map((stamp) => ({
          ...stamp,
          generation: 0,
        })),
      },
      compiled,
    ),
  );
  const failures = targets
    .filter((entry) => !compatible.includes(entry))
    .map((target) =>
      pageFailure(
        target,
        new Error("AI evaluation Worker prompt manifest is obsolete"),
      ),
    );
  const prepared = await adapter.prepare(db, compatible);
  if (
    prepared.length !== compatible.length ||
    new Set(prepared.map((entry) => entry.target.evaluation.id)).size !==
      compatible.length
  )
    throw new Error("AI page adapter returned an unexpected preparation set");
  const ready: Extract<EvaluationPagePreparation<P>, { kind: "ready" }>[] = [];
  let preparedBytes = 0;
  let overflow = false;
  for (const entry of prepared) {
    if (entry.kind === "failed") {
      failures.push(pageFailure(entry.target, entry.error));
      continue;
    }
    const bytes = new TextEncoder().encode(
      JSON.stringify(
        [entry.prepared, entry.target.evaluation.snapshot],
        (_key, value) => (value instanceof Map ? [...value] : value),
      ),
    ).byteLength;
    if (bytes > 4 * 1024 * 1024) {
      failures.push({
        target: entry.target,
        state: "failed",
        error: "AI evaluation evidence exceeds the 4 MiB page bound",
      });
      continue;
    }
    overflow ||= preparedBytes + bytes > 4 * 1024 * 1024;
    if (overflow) {
      failures.push({
        target: entry.target,
        state: "retry_wait",
        error: "AI page evidence suffix remains due",
        wait: { until: new Date(), reason: "provider_capacity" },
      });
      continue;
    }
    preparedBytes += bytes;
    ready.push(entry);
  }
  if (stage) {
    const staged = await stage(db, ready);
    ready.length = 0;
    for (const entry of staged) {
      if (entry.kind === "failed")
        failures.push(pageFailure(entry.target, entry.error));
      else ready.push(entry);
    }
  }
  // Object identity is the existing DecisionRequestBatch's attribution boundary.
  const groups = new Map<string, AiRunContext>();
  const usageFor = (target: EvaluationPageTarget) => {
    const key = JSON.stringify([
      target.evaluation.runId,
      target.evaluation.feature,
      adapter.operation,
      false,
      "default",
    ]);
    let usage = groups.get(key);
    if (!usage) {
      usage = {
        db,
        runId: target.evaluation.runId,
        operation: adapter.operation,
      };
      groups.set(key, usage);
    }
    return usage;
  };
  const outcomes: EvaluationPageOutcome<O>[] = [];
  const settled = await settleDecisionWorkItems(
    ready,
    (entry) =>
      inEvaluationContext(db, entry.target, async () => ({
        target: entry.target,
        evidenceDigest: entry.evidenceDigest,
        outcome: await adapter.evaluate(db, entry, usageFor(entry.target)),
      })),
    adapter.concurrency,
  );
  settled.forEach((result, index) => {
    if (result.status === "fulfilled") outcomes.push(result.value);
    else failures.push(pageFailure(ready[index]!.target, result.reason));
  });
  const publishChunk = async (
    chunk: readonly EvaluationPageOutcome<O>[],
  ): Promise<void> => {
    if (!chunk.length) return;
    try {
      const published = await publishAiEvaluationPage(db, chunk, (tx, valid) =>
        adapter.publish(tx, valid),
      );
      const ids = new Set(published.map((entry) => entry.evaluationId));
      for (const entry of chunk)
        if (!ids.has(entry.target.evaluation.id))
          failures.push(
            pageFailure(
              entry.target,
              new Error("AI evaluation generation or Run is obsolete"),
            ),
          );
    } catch (error) {
      // Only a failed chunk splits; already committed siblings never replay.
      if (chunk.length > 1) {
        const middle = Math.ceil(chunk.length / 2);
        await publishChunk(chunk.slice(0, middle));
        await publishChunk(chunk.slice(middle));
      } else failures.push(pageFailure(chunk[0]!.target, error));
    }
  };
  const chunks: EvaluationPageOutcome<O>[][] = [];
  let weight = 0;
  for (const outcome of outcomes) {
    const cost = Math.max(1, adapter.weight?.(outcome) ?? 1);
    const last = chunks.at(-1);
    if (last && last.length < 25 && weight + cost <= 25) {
      last.push(outcome);
      weight += cost;
    } else {
      chunks.push([outcome]);
      weight = cost;
    }
  }
  for (const chunk of chunks) await publishChunk(chunk);
  await failAiEvaluationPage(db, failures);
  log.info("evaluation page", {
    claimedSlots: targets.length,
    prepared: ready.length,
    completed:
      outcomes.length -
      failures.filter((entry) =>
        outcomes.some((outcome) => outcome.target === entry.target),
      ).length,
    failed: failures.length,
    publicationChunks: chunks.length,
    usageGroups: groups.size,
    preparedBytes,
  });
}

/** Source edges share explicit guarded chunks across the page before enumeration settles. */
export async function executeProductAiRefreshPage(
  db: Database,
  targets: readonly EvaluationPageTarget[],
  ports: AiRefreshPorts = {},
) {
  const adapter = productEvaluationPageAdapter(ports);
  await executeAiRefreshPage(db, targets, adapter, async (database, ready) => {
    type Ready = (typeof ready)[number];
    type Edge = {
      source: Ready;
      pair: z.infer<typeof preparedProductIdentityPair>;
      publication: PreparedProductPairPublication | null;
      request: Parameters<typeof enqueueAiEvaluations>[1][number] | null;
    };
    const edges: Edge[] = [];
    const failures = new Map<string, Error>();
    for (const source of ready) {
      if (source.target.target.kind !== "product") continue;
      source.prepared.enrollment = { rulePairs: 0, requestedPairs: 0 };
      const item = source.target.evaluation;
      for (const pair of source.prepared.pairs) {
        const key = `${item.id}:${productIdentityPairKey(pair.productIds)}`;
        if (pair.exact) {
          const input = await evaluatePreparedProductIdentityPair(
            database,
            pair,
            item.runId,
            {
              ...ports.productIdentityPorts,
              evaluationId: item.id,
              provenance: item.provenance,
              preparedPage: true,
            },
          );
          edges.push({
            source,
            pair,
            publication: {
              key,
              input,
              pair,
              fence:
                source.prepared.pairFences.get(
                  productIdentityPairKey(pair.productIds),
                ) ?? "",
            },
            request: null,
          });
        } else {
          const provenance = aiProvenance.parse({
            ...item.provenance,
            inputFingerprint: pair.fingerprint,
          });
          const shareKey = `product-identity:${await sha256Hex(canonicalJson({ productIds: pair.productIds, fingerprint: pair.fingerprint, dependencies: provenance.dependencies, optionFingerprint: provenance.optionFingerprint }))}`;
          edges.push({
            source,
            pair,
            publication: null,
            request: {
              input: {
                runId: item.runId,
                executionKind: "ai_refresh",
                feature: "product-identity",
                shareKey,
                target: aiEvaluationTarget.parse({
                  kind: "product_pair",
                  entity: "product",
                  recordId: pair.productIds[0],
                  otherId: pair.productIds[1],
                  field: null,
                  assessmentIds: [],
                }),
                provenance,
                snapshot: jsonSnapshot(pair),
              },
            },
          });
        }
      }
    }
    const publish = async (submitted: readonly Edge[]): Promise<void> => {
      const chunk = submitted.filter(
        (edge) => !failures.has(edge.source.target.evaluation.id),
      );
      if (!chunk.length) return;
      const sources = [
        ...new Map(
          chunk.map((edge) => [edge.source.target.evaluation.id, edge.source]),
        ).values(),
      ];
      try {
        await publishAiEvaluationContinuation(
          database,
          sources.map((source) => source.target),
          async (tx) => {
            const fences = await productIdentityEvidenceFences(tx, [
              ...sources.map((source) => ({
                key: source.target.evaluation.id,
                productIds: source.prepared.productIds,
              })),
              ...chunk.map((edge, index) => ({
                key: `edge:${index}`,
                productIds: edge.pair.productIds,
              })),
            ]);
            if (
              sources.some(
                (source) =>
                  fences.get(source.target.evaluation.id) !==
                  source.evidenceDigest,
              ) ||
              chunk.some(
                (edge, index) =>
                  fences.get(`edge:${index}`) !==
                  edge.source.prepared.pairFences.get(
                    productIdentityPairKey(edge.pair.productIds),
                  ),
              )
            )
              throw new Error(
                "Product identity evidence changed during inference",
              );
            const exact = chunk.flatMap((edge) =>
              edge.publication ? [edge.publication] : [],
            );
            if (
              exact.length &&
              (await publishProductIdentityChunk(tx, exact)).some(
                (result) => !result.valid,
              )
            )
              throw new Error(
                "Product identity evidence changed during inference",
              );
            await enqueueAiEvaluations(
              tx,
              chunk.flatMap((edge) => (edge.request ? [edge.request] : [])),
            );
          },
        );
        for (const edge of chunk) {
          const enrollment = edge.source.prepared.enrollment!;
          if (edge.publication) enrollment.rulePairs++;
          else enrollment.requestedPairs++;
        }
      } catch (error) {
        if (chunk.length > 1) {
          const middle = Math.ceil(chunk.length / 2);
          await publish(chunk.slice(0, middle));
          await publish(chunk.slice(middle));
        } else
          failures.set(
            chunk[0]!.source.target.evaluation.id,
            error instanceof Error ? error : new Error(String(error)),
          );
      }
    };
    // A source is the publication authority. Bound each transaction by 25
    // sources, 25 business publications and 100 enrollment edges, rather than
    // spending one guard transaction for every source's sparse candidate set.
    let chunk: Edge[] = [];
    let owners = new Set<string>();
    let publications = 0;
    for (const edge of edges) {
      const owner = edge.source.target.evaluation.id;
      if (
        chunk.length &&
        (chunk.length === 100 ||
          (edge.publication && publications === 25) ||
          (!owners.has(owner) && owners.size === 25))
      ) {
        await publish(chunk);
        chunk = [];
        owners = new Set();
        publications = 0;
      }
      chunk.push(edge);
      owners.add(owner);
      if (edge.publication) publications++;
    }
    await publish(chunk);
    return ready.map((entry) => {
      const error = failures.get(entry.target.evaluation.id);
      return error
        ? { kind: "failed" as const, target: entry.target, error }
        : entry;
    });
  });
}

type ConnectionPagePreparation = {
  source: EntityRef;
  initialConnections?: Awaited<
    ReturnType<
      typeof import("~/server/domains/connection/service/entity-connections").prepareEntityConnections
    >
  >["connections"];
};
type ConnectionPageOutcome = {
  source: EntityRef;
  productPairs: readonly PreparedProductPairPublication[];
  connections: Awaited<
    ReturnType<
      typeof import("~/server/domains/connection/service/entity-connections").prepareEntityConnections
    >
  >["connections"];
  publications: readonly ((transactionDb: Database) => Promise<void>)[];
};

/**
 * Connection sources evaluated at once. A Worker invocation holds five strong
 * connections, so more database-bound sources only queue; the margin overlaps
 * provider waits such as query embeddings.
 */
const CONNECTION_PAGE_CONCURRENCY = 8;

/**
 * A connection evaluation's cost was its own claim, guard and settlement
 * (about 30 round trips for a source with no candidates); a page shares them.
 * Heavy deterministic retrieval shares page inputs; source-local provider
 * continuations join decision waves and publication shares locked evidence.
 */
function connectionEvaluationPageAdapter(
  ports: AiRefreshPorts = {},
): EvaluationPageAdapter<ConnectionPagePreparation, ConnectionPageOutcome> {
  const changed = () =>
    new Error("Connection discovery source changed during evaluation");
  const usageGroups = new Map<AiRunContext, Map<string, AiRunContext>>();
  const operationUsage = (
    page: AiRunContext,
    operation: string,
    recordUsage = true,
  ) => {
    let operations = usageGroups.get(page);
    if (!operations) {
      operations = new Map();
      usageGroups.set(page, operations);
    }
    let usage = operations.get(operation);
    if (!usage) {
      usage = {
        ...page,
        operation,
        force: ports.suggestPorts?.force ?? page.force,
        ...(recordUsage ? {} : { db: undefined }),
      };
      operations.set(operation, usage);
    }
    return usage;
  };
  return {
    operation: "entity-connections",
    concurrency: CONNECTION_PAGE_CONCURRENCY,
    async prepare(db, targets) {
      const { entityGraphRootSchema } =
        await import("@cubby/schemas/entity-graph");
      const sources = targets.map((entry) => {
        const parsed = entityGraphRootSchema.safeParse(
          entry.evaluation.snapshot,
        );
        return parsed.success &&
          entry.target.kind === "connection" &&
          parsed.data.entityKind === entry.target.entity
          ? parsed.data
          : null;
      });
      const present = sources.flatMap((source) => (source ? [source] : []));
      const fingerprints = await connectionSourceFingerprintsOrMissing(
        db,
        present,
      );
      const current = new Map(
        present.map((source, index) => [
          entityRefKey(source.entityKind, source.entityId),
          fingerprints[index],
        ]),
      );
      const { prepareEntityConnectionSources } =
        await import("~/server/domains/connection/service/entity-connections");
      const eligible = present.filter((source) => {
        const index = sources.indexOf(source);
        return (
          current.get(entityRefKey(source.entityKind, source.entityId)) ===
          targets[index]?.evaluation.provenance.inputFingerprint
        );
      });
      const initial = await prepareEntityConnectionSources(db, eligible);
      return targets.map((entry, index) => {
        const source = sources[index];
        const fingerprint = source
          ? current.get(entityRefKey(source.entityKind, source.entityId))
          : null;
        return source &&
          fingerprint === entry.evaluation.provenance.inputFingerprint
          ? {
              kind: "ready" as const,
              target: entry,
              evidenceDigest: fingerprint,
              prepared: {
                source,
                initialConnections: initial.get(source.entityId),
              },
            }
          : { kind: "failed" as const, target: entry, error: changed() };
      });
    },
    async evaluate(db, ready, usage) {
      const { prepareEntityConnections } =
        await import("~/server/domains/connection/service/entity-connections");
      const { source } = ready.prepared;
      const preparation = await prepareEntityConnections(
        db,
        kernel(db, ports, ready.target.evaluation.runId),
        source,
        {
          initialConnections: ready.prepared.initialConnections,
          suggestPorts: {
            ...ports.suggestPorts,
            usageFor:
              ports.suggestPorts?.usageFor ??
              ((operation) =>
                operationUsage(
                  usage,
                  operation,
                  ports.suggestPorts?.recordUsage !== false,
                )),
          },
          productIdentityPorts: {
            ...ports.productIdentityPorts,
            usage:
              ports.productIdentityPorts?.usage ??
              operationUsage(usage, "product-identity"),
          },
        },
      );
      // Incomplete coverage retries the whole source rather than publishing
      // part of its candidates.
      if (!preparation.complete)
        throw new Error(
          `Connection candidate coverage is unconfirmed. ${preparation.coverageErrors.join("\n")}`,
        );
      return {
        source,
        connections: preparation.connections,
        productPairs: preparation.productPairs,
        publications: preparation.publications,
      };
    },
    weight: (entry) =>
      1 +
      entry.outcome.publications.length +
      entry.outcome.connections.length +
      entry.outcome.productPairs.length,
    async publish(tx, outcomes) {
      const fingerprints = await connectionSourceFingerprintsOrMissing(
        tx,
        outcomes.map((entry) => entry.outcome.source),
      );
      const { publishPreparedEntityConnections } =
        await import("~/server/domains/connection/repo/entity-connections");
      const valid = outcomes.filter(
        (entry, index) => fingerprints[index] === entry.evidenceDigest,
      );
      await publishPreparedEntityConnections(
        tx,
        valid.flatMap((entry) => entry.outcome.connections),
      );
      const pairs = [
        ...new Map(
          valid
            .flatMap((entry) => entry.outcome.productPairs)
            .map((pair) => [pair.key, pair]),
        ).values(),
      ];
      for (let offset = 0; offset < pairs.length; offset += 25) {
        const results = await publishProductPairPublications(
          tx,
          pairs.slice(offset, offset + 25),
        );
        if (results.some((result) => !result.valid))
          throw new Error("Product pair evidence changed during inference");
      }

      const published: EvaluationPagePublication[] = [];
      for (const [index, entry] of outcomes.entries()) {
        if (fingerprints[index] !== entry.evidenceDigest) {
          published.push({
            evaluationId: entry.target.evaluation.id,
            state: "obsolete",
            receipt: { reason: changed().message },
          });
          continue;
        }
        for (const publish of entry.outcome.publications) await publish(tx);
        published.push({
          evaluationId: entry.target.evaluation.id,
          state: "completed",
          receipt: jsonSnapshot({
            source: entry.outcome.source,
            discovered: true,
            candidates:
              entry.outcome.publications.length +
              entry.outcome.connections.length +
              entry.outcome.productPairs.length,
          }),
        });
      }
      return published;
    },
  };
}

export async function executeConnectionAiRefreshPage(
  db: Database,
  targets: readonly EvaluationPageTarget[],
  ports: AiRefreshPorts = {},
) {
  await executeAiRefreshPage(
    db,
    targets,
    connectionEvaluationPageAdapter(ports),
  );
}
