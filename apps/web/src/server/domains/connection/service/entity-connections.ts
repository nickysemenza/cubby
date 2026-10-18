import { fieldSuggestionsInput } from "@cubby/schemas/ai";
import type { EntityRef } from "@cubby/schemas/entity";
import type { ConnectionCandidate } from "@cubby/schemas/entity-connections";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import { entityGraphRootSchema } from "@cubby/schemas/entity-graph";
import { basisValueOf } from "@cubby/schemas/field-suggestion";
import { selectDecisionModel } from "@cubby/shared/ai/models";
import { z } from "zod";

import { withAiInputs } from "~/server/ai/evaluation-inputs";
import { suggestFields } from "~/server/ai/field-suggest/suggest-fields";
import {
  dependencyStamps,
  fieldDependencyKeys,
} from "~/server/ai/policy/refresh-manifest";
import {
  evaluateProductIdentity,
  publishProductIdentity,
} from "~/server/ai/product-identity";
import { producingAiManifest } from "~/server/ai/repo/ai-refresh";
import type { Database } from "~/server/db";
import { retrieveConnectionCandidates } from "~/server/domains/connection/repo/connection-candidates";
import { publishEntityConnection } from "~/server/domains/connection/repo/entity-connections";
import {
  prepareConnectionFieldGuard,
  saveConnectionFieldGuard,
} from "~/server/domains/connection/repo/field-connections";
import { getEntityRecommendations } from "~/server/domains/recommendation/service/entity-recommendations.service";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import { jsonValue } from "~/server/domains/run/repo/suggestion-sweep-state";
import { makeSweepSuggestion } from "~/server/domains/run/service/suggestion-sweep";
import { executeEntity } from "~/server/entity-kernel";
import type { EntityKernelContext } from "~/server/entity-kernel/adapter";
import { entityCommandSchema } from "~/server/entity-kernel/contracts";
import { fieldReviewIdentity } from "~/server/generic/assessment/repo/field-assessment-review";
import { latestFieldWrite } from "~/server/generic/audit-log/repo/audit-log";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";

import { discoverAcquisitionCandidates } from "./acquisition-discovery";

const connectionFields = new Map<string, readonly string[]>(
  Object.entries({
    task: ["subjectProductId"],
    product: ["ingredientId", "growsPlantId"],
    cookbook: ["productId"],
    device: ["productId"],
  }),
);

export type ConnectionPreparationPorts = {
  suggestPorts?: Parameters<typeof suggestFields>[3];
  productIdentityPorts?: Parameters<typeof evaluateProductIdentity>[3];
};

/** Model work precedes the authority fence; only the returned publisher writes Assessments. */
export async function prepareEntityConnections(
  db: Database,
  context: EntityKernelContext,
  raw: EntityRef,
  ports: ConnectionPreparationPorts = {},
) {
  const source = entityGraphRootSchema.parse(raw);
  const publishers: ((transactionDb: Database) => Promise<void>)[] = [];
  const retrieved = [
    ...(await retrieveConnectionCandidates(db, source)),
    ...(await discoverAcquisitionCandidates(db, source)),
  ];
  const candidates: ConnectionCandidate[] = [
    ...new Map(
      retrieved.map((candidate) => [
        `${candidate.relation}:${candidate.source.entityId}:${candidate.target.entityId}`,
        candidate,
      ]),
    ).values(),
  ];
  if (source.entityKind === "expense" || source.entityKind === "inventory") {
    const recommendations = await getEntityRecommendations(db, source);
    for (const group of recommendations.groups) {
      if (group.kind === "expense-project")
        for (const proposal of group.proposals)
          candidates.push({
            relation: "expense-project",
            source,
            target: { entityKind: "project", entityId: proposal.target.id },
            label: "Review Project assignment",
            evidence: {
              reasons: proposal.reasons,
              contradictions: [],
              unknowns: [
                "Trade and date overlap are advisory; confirm the expense belongs to this Project",
              ],
            },
          });
      if (group.kind === "inventory-placement")
        for (const proposal of group.proposals)
          candidates.push({
            relation: "inventory-location",
            source,
            target: { entityKind: "location", entityId: proposal.target.id },
            label: "Review inventory placement",
            evidence: {
              reasons: proposal.reasons,
              contradictions: [],
              unknowns: [
                "Another stock destination does not prove this row is physically there",
              ],
            },
          });
    }
  }
  for (const candidate of candidates)
    publishers.push(async (transactionDb) => {
      await publishEntityConnection(transactionDb, candidate);
    });
  if (source.entityKind === "product") {
    const runId = await ensureRun(db, context.actorContext, {
      purpose: "ai_suggest",
    });
    const identity = await evaluateProductIdentity(
      db,
      await resolveOrThrow(db, "product", source.entityId),
      runId,
      ports.productIdentityPorts,
    );
    if (identity.failure) throw new Error(identity.failure);
    publishers.push(async (transactionDb) => {
      await publishProductIdentity(transactionDb, identity);
    });
  }
  publishers.push(
    ...(await prepareFieldConnections(db, context, source, ports)),
  );
  return async (transactionDb: Database) => {
    for (const publish of publishers) await publish(transactionDb);
  };
}

async function prepareFieldConnections(
  db: Database,
  context: EntityKernelContext,
  source: EntityRef,
  ports: ConnectionPreparationPorts,
) {
  const publishers: ((transactionDb: Database) => Promise<void>)[] = [];
  const fields = connectionFields.get(source.entityKind);
  if (!fields) return publishers;
  const entityResult = fieldSuggestionsInput.shape.entity.safeParse(
    source.entityKind,
  );
  if (!entityResult.success)
    throw new Error(
      `Connection inference is not generated for ${source.entityKind}`,
    );
  const entity = entityResult.data;
  const recordId = await resolveOrThrow(db, entity, source.entityId);
  const found = await executeEntity(
    { ...context, db },
    entityCommandSchema.parse({ action: "get", entity, id: source.entityId }),
  );
  if (found.action !== "get" || !found.item)
    throw new Error("Connection source no longer exists");
  const row = z.record(z.string(), z.unknown()).parse(found.item);
  const runId = await ensureRun(db, context.actorContext, {
    purpose: "ai_suggest",
  });
  const model = ports.suggestPorts?.decisionModel ?? selectDecisionModel();
  for (const field of fields) {
    const declaration = entityFieldModels[entity].fields.find(
      (item) => item.key === field,
    );
    const policy = declaration?.control?.suggest;
    if (!policy)
      throw new Error(
        `Missing declared connection inference ${entity}.${field}`,
      );
    const basis = Object.fromEntries(
      [...new Set([...policy.basis, field])].map((key) => [
        key,
        basisValueOf(row[key]),
      ]),
    );
    const currentValue = jsonValue(row[field] ?? null);
    const fieldDecisionId =
      (await latestFieldWrite(db, entity, recordId, field))?.id ?? null;
    const before = await prepareConnectionFieldGuard(db, source);
    const captured = await withAiInputs(false, () =>
      suggestFields(
        db,
        runId,
        {
          entity,
          entityId: source.entityId,
          targets: [field],
          basisMode: "provided",
          basis,
        },
        { ...ports.suggestPorts, decisionModel: model },
      ),
    );
    const decision = captured.result.suggestions[field];
    if (!decision || decision.value === null) continue;
    const entry = makeSweepSuggestion({
      entity,
      field,
      currentValue,
      decision: {
        value: jsonValue(decision.value),
        confidence: decision.probability ?? 0,
      },
      model,
      pinnedModel: model,
    });
    if (!entry) continue;
    // Existing automatic callers retain their policy. This new flow always queues.
    entry.status = "pending";
    const dependencies = dependencyStamps(await producingAiManifest(db), [
      ...fieldDependencyKeys(entity, field),
      ...captured.inputs.map((call) => call.feature),
    ]);
    const servedModel =
      captured.inputs.findLast(
        (call) => call.operation === `suggestFields.${entity}.${field}`,
      )?.model ?? model;
    const reviewKey = await fieldReviewIdentity({
      entity,
      recordId,
      field,
      currentValue,
      proposal: decision,
      model: servedModel,
      inputs: captured.inputs,
      dependencies,
    });
    if (!reviewKey) continue;
    entry.model = servedModel;
    const guard = await saveConnectionFieldGuard(db, {
      source,
      field,
      decision: decision.value,
      before,
      inputs: captured.inputs,
      model: servedModel,
      dependencies,
      reviewKey,
    });
    entry.reviewKey = guard.reviewKey;
    publishers.push((transactionDb) =>
      guard.publish(
        runId,
        {
          entity,
          field,
          recordId,
          currentValue,
          fieldDecisionId,
          unordered: false,
          provenance: guard.provenance,
        },
        [entry],
        { ...context, db: transactionDb },
      ),
    );
  }
  return publishers;
}
