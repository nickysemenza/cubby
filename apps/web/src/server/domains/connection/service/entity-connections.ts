import { fieldSuggestionsInput } from "@cubby/schemas/ai";
import type { EntityRef } from "@cubby/schemas/entity";
import type { ConnectionCandidate } from "@cubby/schemas/entity-connections";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import { entityGraphRootSchema } from "@cubby/schemas/entity-graph";
import { basisValueOf } from "@cubby/schemas/field-suggestion";
import type { ProductId } from "@cubby/schemas/identifiers";
import { z } from "zod";

import { withAiInputs } from "~/server/ai/evaluation-inputs";
import { suggestFields } from "~/server/ai/field-suggest/suggest-fields";
import {
  dependencyStamps,
  fieldDependencyKeys,
} from "~/server/ai/policy/refresh-manifest";
import { evaluateProductIdentity } from "~/server/ai/product-identity";
import { producingAiManifest } from "~/server/ai/repo/ai-refresh";
import type { Database } from "~/server/db";
import { retrieveConnectionCandidates } from "~/server/domains/connection/repo/connection-candidates";
import { prepareEntityConnections as prepareConnectionCandidates } from "~/server/domains/connection/repo/entity-connections";
import {
  prepareConnectionFieldGuard,
  saveConnectionFieldGuard,
} from "~/server/domains/connection/repo/field-connections";
import {
  prepareProductPairPublications,
  publishProductPairPublications,
} from "~/server/domains/product/repo/match/product-match-candidate";
import { getEntityRecommendations } from "~/server/domains/recommendation/service/entity-recommendations.service";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import { jsonValue } from "~/server/domains/run/repo/suggestion-sweep-state";
import { makeSweepSuggestion } from "~/server/domains/run/service/suggestion-sweep";
import { executeEntity } from "~/server/entity-kernel";
import type { EntityKernelContext } from "~/server/entity-kernel/adapter";
import { entityCommandSchema } from "~/server/entity-kernel/contracts";
import { fieldReviewIdentity } from "~/server/generic/assessment/repo/field-assessment-review";
import { prepareTagSuggestions } from "~/server/generic/assessment/service/tag-suggestions";
import { latestFieldWrite } from "~/server/generic/audit-log/repo/field-write";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";
import { TraceNames, withTrace } from "~/server/observability/tracing";

import { discoverAcquisitionCandidateScan } from "./acquisition-discovery";

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

/** Model work precedes the authority fence; each returned unit publishes in a separate fenced transaction. */
export async function prepareEntityConnections(
  db: Database,
  context: EntityKernelContext,
  raw: EntityRef,
  ports: ConnectionPreparationPorts = {},
) {
  const source = entityGraphRootSchema.parse(raw);
  const publishers: ((transactionDb: Database) => Promise<void>)[] = [];
  let productRecordId: ProductId | undefined;
  const stage = <T>(name: string, fn: () => Promise<T>) =>
    withTrace(TraceNames.service("connections", name), fn, {
      "connection.source": source.entityKind,
    });
  // Each stage's new candidates prepare together, before the next stage can
  // await a provider: evidence is captured as retrieved, so a change made
  // while an embedding waits fails the locked basis comparison at publish
  // instead of being captured as if it had been retrieved.
  const captured = new Set<string>();
  const captureCandidates = async (
    candidates: readonly ConnectionCandidate[],
  ) => {
    const fresh = candidates.filter((candidate) => {
      const key = `${candidate.relation}:${candidate.source.entityId}:${candidate.target.entityId}`;
      if (captured.has(key)) return false;
      captured.add(key);
      return true;
    });
    for (const publish of await stage("prepare", () =>
      prepareConnectionCandidates(db, fresh),
    ))
      publishers.push(async (transactionDb) => {
        await publish(transactionDb);
      });
  };
  await stage("retrieve", async () =>
    captureCandidates(await retrieveConnectionCandidates(db, source)),
  );
  // Indexed/semantic retrieval may call a model; preserve earlier candidates first.
  const acquisition = await stage("acquisitionScan", async () => {
    // Query embeddings bill to the evaluation's Run rather than opening one.
    const scan = await discoverAcquisitionCandidateScan(db, source, {
      runId: context.actorContext.runId ?? undefined,
    });
    await captureCandidates(scan.candidates);
    return scan;
  });
  const candidates: ConnectionCandidate[] = [];
  if (source.entityKind === "expense" || source.entityKind === "inventory") {
    const recommendations = await stage("recommendations", () =>
      getEntityRecommendations(db, source),
    );
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
  await captureCandidates(candidates);
  if (source.entityKind === "product") {
    publishers.push(
      ...(
        await stage("tagSuggestions", () =>
          prepareTagSuggestions(db, source.entityId),
        )
      ).map((publish) => async (transactionDb: Database) => {
        await publish(transactionDb);
      }),
    );
    const runId = await ensureRun(db, context.actorContext, {
      purpose: "ai_suggest",
    });
    const recordId = await resolveOrThrow(db, "product", source.entityId);
    productRecordId = recordId;
    const identity = await stage("productIdentity", async () =>
      evaluateProductIdentity(db, recordId, runId, ports.productIdentityPorts),
    );
    if (identity.failure) throw new Error(identity.failure);
    for (let offset = 0; offset < identity.pairs.length; offset += 16) {
      const prepared = await prepareProductPairPublications(
        db,
        identity.pairs
          .slice(offset, offset + 16)
          .map((input, index) => ({ key: String(index), input })),
      );
      if (prepared.length !== identity.pairs.slice(offset, offset + 16).length)
        throw new Error("Product pair evidence changed during inference");
      for (const publication of prepared)
        publishers.push(async (transactionDb) => {
          const [result] = await publishProductPairPublications(transactionDb, [
            publication,
          ]);
          if (!result?.valid)
            throw new Error("Product pair evidence changed during inference");
        });
    }
  }
  publishers.push(
    ...(await stage("fieldConnections", () =>
      prepareFieldConnections(db, context, source, ports, productRecordId),
    )),
  );
  return {
    publications: publishers,
    complete: acquisition.complete,
    coverageErrors: acquisition.coverageErrors,
  };
}

async function prepareFieldConnections(
  db: Database,
  context: EntityKernelContext,
  source: EntityRef,
  ports: ConnectionPreparationPorts,
  resolvedRecordId?: string,
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
  const recordId =
    resolvedRecordId ?? (await resolveOrThrow(db, entity, source.entityId));
  const guards = new Map<
    string,
    Awaited<ReturnType<typeof prepareConnectionFieldGuard>>
  >();
  for (const field of fields)
    guards.set(field, await prepareConnectionFieldGuard(db, source, field));
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
    const before = guards.get(field);
    if (!before)
      throw new Error(`Missing prepared field evidence ${entity}.${field}`);
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
        { ...ports.suggestPorts, recordId },
      ),
    );
    const decision = captured.result.suggestions[field];
    if (!decision || decision.value === null) continue;
    const model =
      [...captured.inputs]
        .reverse()
        .find((call) => call.operation === `suggestFields.${entity}.${field}`)
        ?.model ??
      ports.suggestPorts?.decisionModel ??
      "unknown";
    const entry = makeSweepSuggestion({
      currentValue,
      decision: {
        value: jsonValue(decision.value),
        confidence: decision.probability ?? 0,
      },
      model,
    });
    if (!entry) continue;
    const dependencies = dependencyStamps(await producingAiManifest(db), [
      ...fieldDependencyKeys(entity, field),
      ...captured.inputs.map((call) => call.feature),
    ]);
    const servedModel =
      [...captured.inputs]
        .reverse()
        .find((call) => call.operation === `suggestFields.${entity}.${field}`)
        ?.model ?? model;
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
