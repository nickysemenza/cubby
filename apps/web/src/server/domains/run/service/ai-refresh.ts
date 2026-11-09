import { fieldSuggestionsInput, fieldSuggestionsOut } from "@cubby/schemas/ai";
import {
  aiEvaluationTarget,
  aiProvenance,
  type AiEvaluationTarget,
} from "@cubby/schemas/ai-evaluation";
import { systemActor } from "@cubby/schemas/context";
import { entityRefKey } from "@cubby/schemas/entity";
import { entityFieldEnvelopeFields } from "@cubby/schemas/entity-field-envelopes";
import { fieldEnvelopeFor, fieldValueOf } from "@cubby/schemas/field-envelope";
import {
  basisValueOf,
  fieldSuggestionContextKeys,
  fieldSuggestionResolutionContext,
} from "@cubby/schemas/field-suggestion";
import { parseEntityRef, runEntityId } from "@cubby/schemas/identifiers";
import { supportedDecisionModelSchema } from "@cubby/shared/ai/models";
import { sha256Hex } from "@cubby/shared/sha256";
import { createLogger } from "@cubby/worker-tracing";
import { z } from "zod";

import { scrubErrorMessage } from "~/lib/error-diagnostics";
import { decisionCatalogRows } from "~/server/ai/decision-catalog";
import { withAiInputs } from "~/server/ai/evaluation-inputs";
import {
  AiEvaluationAttemptObsoleteError,
  publishAiEvaluation,
  storeAiEvaluationResult,
  type ClaimedAiEvaluation,
} from "~/server/ai/evaluation/repo/ai-evaluation";
import {
  suggestFields,
  type SuggestFieldsPorts,
} from "~/server/ai/field-suggest/suggest-fields";
import { aiRunOwner } from "~/server/ai/policy/call-owner";
import {
  compiledRefreshManifest,
  dependencyStamps,
  fieldDependencyKeys,
  fieldPolicyKey,
} from "~/server/ai/policy/refresh-manifest";
import { readAiRefreshActivation } from "~/server/ai/repo/ai-refresh";
import type { Database } from "~/server/db";
import { scheduleAutomaticEvaluations } from "~/server/domains/run/repo/ai-refresh-state";
import type { EntityKernelContext } from "~/server/entity-kernel/adapter";
import { readSelectedEntityRecords } from "~/server/entity-kernel/selected-read";
import { latestFieldWrite } from "~/server/generic/audit-log/repo/field-write";
import { JobEvidenceObsoleteError } from "~/server/generic/jobs/errors";
import { lookupShortcodes } from "~/server/generic/shortcode/repo/shortcode-resolver";
import {
  fieldInputFingerprint,
  fenceFieldInputsAtCommit,
} from "~/server/generic/suggestions/repo/field-input-fence";
import { fieldReviewIdentity } from "~/server/generic/suggestions/repo/field-suggestion-review";
import { buildCrudServices } from "~/server/http/request-context";

import {
  suggestionStatesById,
  settleAppliedFieldRefresh,
} from "../repo/ai-refresh-state";
import { guardAiEvaluationAttempt } from "../repo/ai-work-state";
import {
  makeSweepSuggestion,
  publishSweepSuggestions,
} from "./suggestion-sweep";

const log = createLogger("ai-refresh");

export type AiRefreshPorts = {
  context?: EntityKernelContext;
  suggestPorts?: SuggestFieldsPorts;
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
  output: fieldSuggestionsOut,
  provenance: aiProvenance,
});

function kernel(
  db: Database,
  ports: AiRefreshPorts,
  runId?: string | null,
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

type FieldTarget = Extract<AiEvaluationTarget, { kind: "field" }>;

function fieldReadRequest(target: FieldTarget) {
  const parsed = fieldSuggestionsInput.shape.entity.safeParse(target.entity);
  if (!parsed.success) return null;
  const entity = parsed.data;
  const policy = decisionCatalogRows().find(
    (row) => row.entity === entity && row.field === target.field,
  );
  if (!policy) return null;
  const policyKeys = [...policy.basis.map((row) => row.key), target.field];
  return {
    entity,
    recordId: target.recordId,
    policyKeys,
    keys: fieldSuggestionContextKeys(entity, policyKeys),
  };
}

type FieldReadRequest = NonNullable<ReturnType<typeof fieldReadRequest>>;

async function readFieldRecord(
  db: Database,
  request: FieldReadRequest,
  ports: AiRefreshPorts,
) {
  const codes = await lookupShortcodes(db, [
    parseEntityRef(request.entity, request.recordId),
  ]);
  const publicId = codes.get(entityRefKey(request.entity, request.recordId));
  if (!publicId) return null;
  const [record] = await readSelectedEntityRecords({
    context: kernel(db, ports),
    entity: request.entity,
    ids: [publicId],
    fields: request.keys,
  });
  return record ? { publicId, record } : null;
}

async function prepareField(
  db: Database,
  target: FieldTarget,
  ports: AiRefreshPorts,
  started?: {
    manifest: NonNullable<
      Awaited<ReturnType<typeof currentAiRefreshActivation>>
    >["manifest"];
    record: (request: FieldReadRequest) => ReturnType<typeof readFieldRecord>;
  },
) {
  const request = fieldReadRequest(target);
  if (!request) return null;
  const { entity, policyKeys } = request;
  const loaded = await (started
    ? started.record(request)
    : readFieldRecord(db, request, ports));
  if (!loaded) return null;
  const { publicId, record } = loaded;
  const context = kernel(db, ports);
  const governedFields = entityFieldEnvelopeFields[entity];
  const valueOf = (key: string) => {
    if (!Object.hasOwn(governedFields, key)) return record[key];
    const envelope = fieldEnvelopeFor(record, key);
    return envelope ? fieldValueOf(envelope) : null;
  };
  const targetEnvelope = fieldEnvelopeFor(record, target.field);
  if (
    Object.hasOwn(governedFields, target.field) &&
    (!targetEnvelope || targetEnvelope.result.kind === "missing")
  )
    return null;
  // Effective values drive comparison; the full envelope retains assignment intent and ownership.
  const basis = Object.fromEntries(
    fieldSuggestionContextKeys(entity, policyKeys).map((key) => [
      key,
      basisValueOf(valueOf(key)),
    ]),
  );
  basis.__resolutionContext = fieldSuggestionResolutionContext(
    record.fields,
    policyKeys,
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
    currentValue: valueOf(target.field) ?? null,
  });
  const manifest =
    started?.manifest ??
    (await readAiRefreshActivation(db))?.manifest ??
    (await compiledRefreshManifest());
  const prepared = await withAiInputs(true, () =>
    suggestFields(
      db,
      aiRunOwner(context.actorContext.runId),
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
export function savedFieldQuestionScheduler(
  db: Database,
  targets: readonly FieldTarget[],
  ports: AiRefreshPorts = {},
) {
  let activation: ReturnType<typeof currentAiRefreshActivation> | undefined;
  let records:
    | Promise<Awaited<ReturnType<typeof loadRecords>> | null>
    | undefined;
  const requests = targets.flatMap((target) => {
    const request = fieldReadRequest(target);
    return request ? [request] : [];
  });
  async function loadRecords() {
    const found = new Map<
      string,
      NonNullable<Awaited<ReturnType<typeof readFieldRecord>>>
    >();
    const codes = await lookupShortcodes(
      db,
      requests.map((request) =>
        parseEntityRef(request.entity, request.recordId),
      ),
    );
    for (const entity of new Set(requests.map((request) => request.entity))) {
      const group = requests.filter((request) => request.entity === entity);
      const ids = [
        ...new Set(
          group.flatMap((request) => {
            const code = codes.get(entityRefKey(entity, request.recordId));
            return code ? [code] : [];
          }),
        ),
      ];
      if (!ids.length) continue;
      const rows = await readSelectedEntityRecords({
        context: kernel(db, ports),
        entity,
        ids,
        fields: [...new Set(group.flatMap((request) => request.keys))],
      });
      const byId = new Map(rows.map((row) => [row.id, row]));
      for (const request of group) {
        const key = entityRefKey(entity, request.recordId);
        const publicId = codes.get(key);
        const record = publicId ? byId.get(publicId) : undefined;
        if (publicId && record) found.set(key, { publicId, record });
      }
    }
    return found;
  }
  return async (target: FieldTarget) => {
    const current = await (activation ??= currentAiRefreshActivation(db));
    if (!current) return;
    const prepared = await prepareField(db, target, ports, {
      manifest: current.manifest,
      record: async (request) => {
        // A failed union must retain the singleton's error and sibling isolation.
        const shared = await (records ??= loadRecords().catch((error) => {
          log.warn("Saved field input batch fell back to narrow reads", {
            error: scrubErrorMessage(String(error)),
          });
          return null;
        }));
        return (
          shared?.get(entityRefKey(request.entity, request.recordId)) ??
          readFieldRecord(db, request, ports)
        );
      },
    });
    if (
      !prepared ||
      (prepared.snapshot.currentValue !== null &&
        prepared.snapshot.currentValue !== "")
    )
      return;
    // Admission and field-specific fences remain independent, including capacity deferral.
    const result = await scheduleAutomaticEvaluations(db, [
      { target, provenance: prepared.provenance, snapshot: prepared.snapshot },
    ]);
    if (result.kind === "deferred")
      log.info("Saved field evaluation scheduling deferred", {
        reason: result.reason,
        entity: target.entity,
        recordId: target.recordId,
        field: target.field,
      });
  };
}

/** Field and Email refresh evaluate one claimed item; the drain owns retries and failures. */
export async function executeAiRefreshTarget(
  db: Database,
  claimed: ClaimedAiEvaluation,
  ports: AiRefreshPorts = {},
) {
  const { id, attemptToken: token } = claimed;
  await guardAiEvaluationAttempt(db, id, token);
  const target = aiEvaluationTarget.parse(claimed.target);
  if (target.kind !== "field")
    throw new Error(`AI refresh no longer evaluates ${target.kind} targets`);
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
    prepared.provenance.inputFingerprint !== claimed.provenance.inputFingerprint
  )
    throw new JobEvidenceObsoleteError(
      "AI evaluation target changed during inference",
    );
  const previous = await suggestionStatesById(db, target.suggestionIds);
  if (
    previous.length !== target.suggestionIds.length ||
    previous.some(
      (row) =>
        row.acceptanceReceipt === null &&
        !["pending", "superseded", "applied"].includes(row.status),
    )
  )
    throw new JobEvidenceObsoleteError(
      "AI evaluation member decision is obsolete",
    );
  let result = fieldResult.safeParse(claimed.result);
  if (!result.success) {
    const evaluated = await withAiInputs(false, () =>
      suggestFields(
        db,
        aiRunOwner(claimed.runId),
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
        [...evaluated.inputs]
          .reverse()
          .find(
            (call) =>
              call.operation ===
              `suggestFields.${snapshot.entity}.${snapshot.field}`,
          )?.model ??
        snapshot.decisionModelOverride ??
        null,
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
    });
    if (!result.success) throw result.error;
    if (
      !(await storeAiEvaluationResult(
        db,
        { id, attemptToken: token },
        jsonSnapshot(result.data),
      ))
    )
      throw new AiEvaluationAttemptObsoleteError();
  }
  const saved = result.data;
  await publishAiEvaluation(db, id, token, async (tx) => {
    const now = await prepareField(tx, target, fieldPorts);
    if (
      !now ||
      now.provenance.inputFingerprint !== claimed.provenance.inputFingerprint
    )
      throw new JobEvidenceObsoleteError(
        "AI evaluation target changed during inference",
      );
    const decision = saved.output.suggestions[snapshot.field];
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
        predecessorIds: target.suggestionIds,
        evaluationId: id,
        provenance: saved.provenance,
      },
      entry
        ? [
            {
              ...entry,
              reviewKey: saved.reviewKey,
              model: saved.provenance.model ?? entry.model,
            },
          ]
        : [],
      decision?.financeReview?.fingerprint ?? null,
      kernel(tx, ports, claimed.runId),
      (error) => applicationFailures.push(scrubErrorMessage(String(error))),
    );
    const [predecessorId] = target.suggestionIds;
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
}
