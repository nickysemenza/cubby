import { fieldSuggestionsInput, fieldSuggestionsOut } from "@cubby/schemas/ai";
import {
  aiEvaluationTarget,
  aiProvenance,
  aiRefreshRunInput,
  aiRefreshActivation,
  type AiEvaluationTarget,
} from "@cubby/schemas/ai-evaluation";
import { buildActorContext } from "@cubby/schemas/context";
import { entityRefKey } from "@cubby/schemas/entity";
import { basisValueOf } from "@cubby/schemas/field-suggestion";
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
} from "~/server/ai/policy/refresh-manifest";
import {
  evaluateProductIdentity,
  prepareProductIdentityCatalog,
  evaluatePreparedProductIdentityPair,
} from "~/server/ai/product-identity";
import {
  claimAiEvaluation,
  publishAiEvaluation,
} from "~/server/ai/repo/ai-evaluation";
import {
  readAiRefreshActivation,
  readAiDiscoveryCursor,
  saveAiDiscoveryCursor,
} from "~/server/ai/repo/ai-refresh";
import type { Database } from "~/server/db";
import { productIdentityEvidenceFence } from "~/server/domains/product/repo/match/product-identity-fence";
import {
  productIdentitySnapshot,
  prepareProductIdentityPair,
  prepareProductIdentityPairRequest,
  preparedProductIdentityPair,
} from "~/server/domains/product/repo/match/product-identity-snapshot";
import { prepareProductPairPublication } from "~/server/domains/product/repo/match/product-match-candidate";
import { executeEntity } from "~/server/entity-kernel";
import type { EntityKernelContext } from "~/server/entity-kernel/adapter";
import { entityCommandSchema } from "~/server/entity-kernel/contracts";
import { applyAutomaticRules } from "~/server/generic/assessment/repo/automatic-rule-runtime";
import {
  fieldCorrectionIdentity,
  fieldReviewIdentity,
} from "~/server/generic/assessment/repo/field-assessment-review";
import { publishFieldCorrectionQuestion } from "~/server/generic/assessment/repo/field-correction-publication";
import {
  fieldInputFingerprint,
  fenceFieldInputsAtCommit,
  fieldInputFingerprintIfLive,
} from "~/server/generic/assessment/repo/field-input-fence";
import { latestFieldWrite } from "~/server/generic/audit-log/repo/field-write";
import { currentJobExecution } from "~/server/generic/jobs/context";
import { JobDeferredError } from "~/server/generic/jobs/errors";
import { lookupShortcodes } from "~/server/generic/shortcode/repo/shortcode-resolver";
import { buildCrudServices } from "~/server/http/request-context";
import { canonicalJson } from "~/server/lib/canonical-json";

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
  countConnectionSweepSources,
} from "../repo/connection-refresh";
import { systemActor } from "../repo/ensure-run";
import {
  makeSweepSuggestion,
  publishSweepSuggestions,
} from "./suggestion-sweep";

const log = createLogger("ai-refresh");

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
    [...new Set([...policy.basis.map((row) => row.key), target.field])].map(
      (key) => [key, basisValueOf(record[key])],
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
  for (const item of products) {
    const prepared = await productIdentitySnapshot(db, item.id);
    if (!prepared) continue;
    const provenance = aiProvenance.parse({
      dependencies: dependencyStamps(activation.manifest, ["product-identity"]),
      inputFingerprint: prepared.fingerprint,
      optionFingerprint: "canonical-product-pairs-v1",
      model: null,
    });
    const target = aiEvaluationTarget.parse({
      kind: "product",
      entity: "product",
      recordId: item.id,
      field: null,
      assessmentIds: [],
    });
    const key = await sha256Hex(JSON.stringify([item.id, provenance]));
    const productRun = await scheduleEvaluationRun(
      db,
      ports.context?.actorContext ?? systemActor(),
      {
        purpose: "ai_refresh",
        trigger: "scheduled",
        status: "running",
        clientKey: `ai-refresh:product:${key}`,
        input: aiRefreshRunInput.parse({ kind: "ai_refresh", activation }),
      },
      [{ target, provenance, snapshot: prepared.snapshot }],
    );
    if (productRun.kind === "scheduled") scheduledRuns.add(productRun.runId);
    if (productRun.kind === "deferred") {
      deferred = true;
      break;
    }
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
      const checkSource = async (transactionDb: Database) => {
        if (
          (await connectionSourceFingerprint(transactionDb, source)) !==
          claimed.provenance.inputFingerprint
        )
          throw new Error(
            "Connection discovery source changed during evaluation",
          );
      };
      for (const publish of preparation.publications)
        await publishAiEvaluation(
          db,
          id,
          token,
          async (transactionDb) => {
            await checkSource(transactionDb);
            await publish(transactionDb);
            await checkConnectionSourceBeforeCommit(transactionDb, () =>
              connectionSourceFingerprint(transactionDb, source),
            );
            return null;
          },
          "continue",
        );
      await publishAiEvaluation(db, id, token, async (transactionDb) => {
        await checkSource(transactionDb);
        if (!preparation.complete)
          throw new Error(
            `Connection candidate coverage is unconfirmed. ${preparation.coverageErrors.join("\n")}`,
          );
        await checkConnectionSourceBeforeCommit(transactionDb, () =>
          connectionSourceFingerprint(transactionDb, source),
        );
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
      for (const pair of prepared.pairs)
        if (pair.exact) {
          exactResults.set(
            pair.fingerprint,
            await evaluatePreparedProductIdentityPair(db, pair, claimed.runId, {
              ...ports.productIdentityPorts,
              evaluationId: id,
              provenance: claimed.provenance,
            }),
          );
        }
      let rulePairs = 0,
        requestedPairs = 0;
      for (const pair of prepared.pairs) {
        // Preparation never inherits a transaction or activation/Run/item locks.
        // Every pair commits under its own attempt/Run/activation fence. Retrying
        // a partial catalog uses the existing idempotent publication/work keys.
        const result = exactResults.get(pair.fingerprint);
        if (pair.exact && !result)
          throw new Error("Prepared exact Product identity result is missing");
        const publish = result
          ? await prepareProductPairPublication(db, result)
          : await prepareProductIdentityPairRequest(
              db,
              pair,
              claimed.runId,
              claimed.provenance,
            );
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
        if (result) rulePairs++;
        else requestedPairs++;
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
          fieldPorts.suggestPorts,
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
    const obsolete =
      /obsolete|changed during inference|decided during inference|no longer exists/.test(
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
