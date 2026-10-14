import { fieldSuggestionsInput, fieldSuggestionsOut } from "@cubby/schemas/ai";
import {
  aiEvaluationState,
  suggestionSupersessionReceipt,
  aiEvaluationTarget,
  aiProvenance,
  aiRefreshRunInput,
  aiRefreshActivation,
  type AiEvaluationTarget,
  type AiProvenance,
} from "@cubby/schemas/ai-evaluation";
import { buildActorContext } from "@cubby/schemas/context";
import { entityRefKey } from "@cubby/schemas/entity";
import {
  parseEntityRef,
  parseEntityId,
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
  productIdentitySnapshot,
  evaluateProductIdentity,
  publishProductIdentity,
  prepareProductIdentityCatalog,
  prepareProductIdentityPair,
  evaluatePreparedProductIdentityPair,
  enqueueProductIdentityPair,
  preparedProductIdentityPair,
} from "~/server/ai/product-identity";
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
  product,
  email,
  emailClassificationObservation,
  ledgerParty,
  run,
  assessmentState as suggestion,
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
  productIdentityPorts?: Parameters<typeof evaluateProductIdentity>[3];
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
      feature:
        target.kind === "field"
          ? "field-suggestion"
          : target.kind === "product"
            ? "product-identity"
            : "mailbox-triage",
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

async function scheduleProductIdentityDiscovery(
  db: Database,
  activation: z.infer<typeof aiRefreshActivation>,
  cursor: Awaited<ReturnType<typeof readAiDiscoveryCursor>>,
  ports: AiRefreshPorts,
) {
  const scheduledRuns = new Set<string>();
  const products = cursor.productDone
    ? []
    : await getDb(db)
        .select({ id: product.id })
        .from(product)
        .where(
          and(
            notDeleted(product),
            cursor.product
              ? gt(product.id, parseEntityId("product", cursor.product))
              : undefined,
          ),
        )
        .orderBy(product.id)
        .limit(EMAIL_RECLASSIFY_LIMIT);
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
    if (productRun) scheduledRuns.add(productRun);
  }
  return {
    runs: [...scheduledRuns],
    productDone: cursor.productDone || products.length < EMAIL_RECLASSIFY_LIMIT,
    product:
      products.length === EMAIL_RECLASSIFY_LIMIT ? products.at(-1)!.id : null,
  };
}

const fieldCursorFor = (
  pending: readonly Pick<
    typeof suggestion.$inferSelect,
    "entity" | "recordId" | "field"
  >[],
) =>
  pending.length === EMAIL_RECLASSIFY_LIMIT ? (pending.at(-1) ?? null) : null;
const emailCursorFor = (rows: readonly { item: { id: string } }[]) =>
  rows.length === EMAIL_RECLASSIFY_LIMIT * 2 ? rows.at(-1)!.item.id : null;

/** Preparation enumerates evidence using live renderers; no model calls happen here. */
export async function discoverAiRefresh(
  db: Database,
  ports: AiRefreshPorts = {},
) {
  const activation = await readAiRefreshActivation(db);
  if (!activation?.enabled) return [];
  const runs = new Set<string>();
  let cursor = await readAiDiscoveryCursor(db);
  if (
    cursor.revision !== activation.revision ||
    (cursor.fieldDone && cursor.emailDone && cursor.productDone)
  )
    cursor = {
      revision: activation.revision,
      field: null,
      email: null,
      fieldDone: false,
      emailDone: false,
      productDone: false,
      product: null,
    };
  const eligibleSuggestions = or(
    eq(suggestion.status, "pending"),
    and(
      eq(suggestion.status, "superseded"),
      sql`${suggestion.supersessionReceipt}->>'reason' IN (${suggestionSupersessionReceipt.shape.reason.enum.input_changed}, ${suggestionSupersessionReceipt.shape.reason.enum.no_proposal})`,
    ),
  );
  const pending = cursor.fieldDone
    ? []
    : await getDb(db)
        .selectDistinctOn([
          suggestion.entity,
          suggestion.recordId,
          suggestion.field,
        ])
        .from(suggestion)
        .where(
          and(
            eligibleSuggestions,
            eq(suggestion.family, "field"),
            eq(suggestion.active, true),
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
        assessmentIds: rows.map((row) => row.id),
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
  const candidates = cursor.emailDone
    ? []
    : await getDb(db)
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
              assessmentIds: [],
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
  const productDiscovery = await scheduleProductIdentityDiscovery(
    db,
    activation,
    cursor,
    ports,
  );
  for (const productRun of productDiscovery.runs) runs.add(productRun);
  await saveAiDiscoveryCursor(db, {
    revision: activation.revision,
    productDone: productDiscovery.productDone,
    product: productDiscovery.product,
    fieldDone: cursor.fieldDone || pending.length < EMAIL_RECLASSIFY_LIMIT,
    emailDone:
      cursor.emailDone || candidates.length < EMAIL_RECLASSIFY_LIMIT * 2,
    field: fieldCursorFor(pending),
    email: emailCursorFor(candidates),
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
          model: claimed.provenance.model,
          evaluationId: id,
          provenance: claimed.provenance,
        },
      );
      await publishAiEvaluation(db, id, token, async (transactionDb) => {
        const latest = await prepareProductIdentityPair(
          transactionDb,
          prepared.productIds,
        );
        if (!latest || latest.fingerprint !== prepared.fingerprint)
          throw new Error("Product pair evidence changed during inference");
        await publishProductIdentity(transactionDb, { pairs: [result] });
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
      await publishAiEvaluation(db, id, token, async (transactionDb) => {
        const latest = await productIdentitySnapshot(transactionDb, productId);
        if (!latest || latest.fingerprint !== source.fingerprint)
          throw new Error("Product identity evidence changed during inference");
        let rulePairs = 0,
          requestedPairs = 0;
        for (const pair of prepared.pairs) {
          const current = await prepareProductIdentityPair(
            transactionDb,
            pair.productIds,
          );
          if (!current || current.fingerprint !== pair.fingerprint)
            throw new Error("Product pair evidence changed during inference");
          if (pair.exact) {
            const result = await evaluatePreparedProductIdentityPair(
              transactionDb,
              pair,
              claimed.runId,
              { evaluationId: id, provenance: claimed.provenance },
            );
            await publishProductIdentity(transactionDb, { pairs: [result] });
            rulePairs++;
          } else {
            await enqueueProductIdentityPair(
              transactionDb,
              pair.productIds,
              claimed.runId,
              claimed.provenance,
            );
            requestedPairs++;
          }
        }
        return {
          eligible: prepared.eligible,
          excluded: !prepared.eligible ? "misc_or_deleted" : null,
          rulePairs,
          requestedPairs,
          catalogEnumeration: true,
        };
      });
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
      .where(inArray(suggestion.id, target.assessmentIds));
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
          predecessorIds: target.assessmentIds,
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

export async function aiRefreshRelaunchCandidates(db: Database) {
  const current = await readAiRefreshActivation(db);
  return getDb(db)
    .select({ id: run.id })
    .from(run)
    .where(
      and(
        eq(run.purpose, "ai_refresh"),
        notDeleted(run),
        or(
          eq(run.status, "failed"),
          and(
            eq(run.status, "running"),
            sql`COALESCE((${run.progress}->>'attempt')::integer, 0) = 0`,
          ),
        ),
        sql`${run.failureCode} IS DISTINCT FROM 'user_cancelled'`,
        or(
          and(
            sql`${run.input}->>${aiRefreshRunInput.keyof().enum.discovery} = 'true'`,
            current?.discoveryRunId
              ? eq(run.id, runEntityId.parse(current.discoveryRunId))
              : sql`false`,
          ),
          sql`EXISTS (SELECT 1 FROM "AiEvaluation" AS eligible WHERE eligible."runId" = ${run.id} AND eligible.state IN (${aiEvaluationState.enum.queued}, ${aiEvaluationState.enum.running}, ${aiEvaluationState.enum.result_ready}, ${aiEvaluationState.enum.retry_wait}))`,
        ),
      ),
    )
    .orderBy(asc(run.updatedAt), asc(run.id))
    .limit(10);
}

export async function recoverAiRefresh(db: Database) {
  const { getAiRefreshEnabled } = await import("~/server/cf-env");
  const enabled = getAiRefreshEnabled();
  if (!enabled) return false;
  const current = await readAiRefreshActivation(db);
  // The singleton owns activation. An old Worker can still receive recovery work.
  if (!current?.enabled) return false;
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
    return false;
  const { reconcileWorkflowRuns } =
    await import("~/server/workflow-runs/lifecycle");
  await reconcileWorkflowRuns(db);
  const unfinished = await aiRefreshRelaunchCandidates(db);
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
        if (!runnable && !aiRefreshRunInput.parse(row.input).discovery)
          continue;
        await launchWorkflowRun(db, {
          runId: runEntityId.parse(id),
          purpose: "ai_refresh",
          automatic: true,
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
  return true;
}
