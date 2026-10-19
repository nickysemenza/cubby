import { suggestionStatus } from "@cubby/schemas/ai";
import {
  assessmentChildHandle,
  assessmentProducer,
  type AssessmentProducer,
} from "@cubby/schemas/assessment";
import {
  parseEntityId,
  productId,
  type ProductId,
} from "@cubby/schemas/identifiers";
import { sha256Hex } from "@cubby/shared/sha256";
import {
  and,
  eq,
  inArray,
  isNull,
  or,
  sql,
  getTableColumns,
} from "drizzle-orm";
import type { PgTransactionConfig } from "drizzle-orm/pg-core";
import { z } from "zod";

import {
  PRODUCT_IDENTITY_FEATURE,
  PRODUCT_IDENTITY_RULE_REVISION,
} from "~/server/ai/policy/feature-identity";
import type { Database, DrizzleTransaction } from "~/server/db";
import {
  databaseForTransaction,
  getDb,
  isTransaction,
  withTransactionDatabase,
} from "~/server/db/helpers";
import { assessment, assessmentState } from "~/server/db/schema";
import { variantVerification } from "~/server/domains/product/repo/product-variant-evidence";
import { publishAssessment } from "~/server/generic/assessment/repo/assessment";

import { productIdentityEvidenceFence } from "./product-identity-fence";
import { prepareProductIdentityPair } from "./product-identity-snapshot";

const pairProjection = z.object({
  otherId: productId,
  source: z.enum(["agent", "detector"]),
  evidence: z.string().nullable(),
  sourceUrls: z.array(z.string()),
  signals: z.json().optional(),
  actionable: z.boolean().default(false),
  conflict: z.boolean().default(false),
});
const pairRow = z.object({
  id: assessmentChildHandle,
  productAId: productId,
  productBId: productId,
  source: z.enum(["agent", "detector"]),
  state: z.enum(["open", "dismissed"]),
  evidence: z.string().nullable(),
  sourceUrls: z.array(z.string()),
  createdAt: z.date(),
  updatedAt: z.date(),
  fingerprint: z.string().nullable(),
  actionable: z.boolean(),
  conflict: z.boolean(),
  verification: variantVerification.default("unknown"),
  /** Stored detector signals (snapshots, grounded variant evidence). */
  signals: z.json().optional(),
});
export type ProductMatchCandidateRow = z.infer<typeof pairRow>;
const canonicalProductPair = (a: ProductId, b: ProductId) =>
  a < b ? { productAId: a, productBId: b } : { productAId: b, productBId: a };
export const productPairKey = (a: string, b: string): string =>
  a < b ? `${a}|${b}` : `${b}|${a}`;
export const currentProductPairPolicy = (producer: AssessmentProducer | null) =>
  !producer ||
  producer.kind === "agent" ||
  (producer.kind === "rule" &&
    producer.revision === PRODUCT_IDENTITY_RULE_REVISION) ||
  (producer.kind === "model" &&
    producer.revision === PRODUCT_IDENTITY_FEATURE.promptVersion);

export async function publishProductPair(
  db: Database,
  input: {
    productIds: readonly [ProductId, ProductId];
    source: "agent" | "detector";
    evidence: string | null;
    sourceUrls: string[];
    signals?: z.infer<typeof pairProjection>["signals"];
    actionable?: boolean;
    conflict?: boolean;
    fingerprint?: string | null;
    producer?: AssessmentProducer;
  },
): Promise<ProductMatchCandidateRow & { created: boolean }> {
  return publishProductPairWithGuard(db, input, (transactionDb) => {
    const suppliedSignals =
      z.record(z.string(), z.json()).safeParse(input.signals).data ?? {};
    return prepareProductIdentityPair(transactionDb, input.productIds, {
      variantEvidence: suppliedSignals.variantEvidence,
    });
  });
}

/** Snapshot/variant work runs before the caller opens its publication transaction. */
export async function prepareProductPairPublication(
  db: Database,
  input: Parameters<typeof publishProductPair>[1],
) {
  if (isTransaction(getDb(db)))
    throw new Error(
      "Product pair preparation requires a database outside a transaction",
    );
  const fence = await productIdentityEvidenceFence(db, input.productIds);
  const suppliedSignals =
    z.record(z.string(), z.json()).safeParse(input.signals).data ?? {};
  const guard = await prepareProductIdentityPair(db, input.productIds, {
    variantEvidence: suppliedSignals.variantEvidence,
  });
  if (
    !guard ||
    (input.fingerprint && guard.fingerprint !== input.fingerprint) ||
    (await productIdentityEvidenceFence(db, input.productIds)) !== fence
  )
    throw new Error("Product pair evidence changed during inference");
  return (tx: Database) =>
    publishProductPairWithGuard(
      tx,
      input,
      async (transactionDb) => {
        if (
          (await productIdentityEvidenceFence(
            transactionDb,
            input.productIds,
          )) !== fence
        )
          throw new Error("Product pair evidence changed during inference");
        return guard;
      },
      { isolationLevel: "serializable" },
    );
}

async function publishProductPairWithGuard(
  db: Database,
  input: Parameters<typeof publishProductPair>[1],
  prepare: (tx: Database) => ReturnType<typeof prepareProductIdentityPair>,
  config?: PgTransactionConfig,
): Promise<ProductMatchCandidateRow & { created: boolean }> {
  const pair = canonicalProductPair(...input.productIds);
  if (pair.productAId === pair.productBId)
    throw new Error("Cannot assess a Product against itself");
  const proposedData = pairProjection.parse({
    otherId: pair.productBId,
    ...input,
  });
  return withTransactionDatabase(
    db,
    async (transactionDb) => {
      const client = getDb(transactionDb);
      await client.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`product-pair-state:${pair.productAId}|${pair.productBId}`},0))`,
      );
      const suppliedSignals =
        z.record(z.string(), z.json()).safeParse(proposedData.signals).data ??
        {};
      const guard = await prepare(transactionDb);
      if (!guard) throw new Error("Product identity target no longer exists");
      let data = pairProjection.parse({
        ...proposedData,
        conflict: proposedData.conflict || guard.conflict,
        evidence:
          guard.verification === "pending_verification"
            ? "A historical variant conflict requires fresh current verification before merging"
            : proposedData.evidence,
        signals: {
          ...suppliedSignals,
          verification: guard.verification,
          variantEvidence: guard.variantEvidence,
          conflictLineage: guard.priorConflictIds,
        },
      });
      const proof = guard.variantEvidence;
      const semanticProof = z
        .object({ producer: assessmentProducer })
        .passthrough()
        .safeParse(proof);
      const identityData = {
        ...data,
        signals: {
          ...suppliedSignals,
          conflictLineage: null,
          verification: guard.verification,
          variantEvidence: semanticProof.success
            ? {
                ...semanticProof.data,
                producer: {
                  ...semanticProof.data.producer,
                  runId: null,
                  evaluationId: null,
                },
              }
            : null,
        },
      };
      const digest = await sha256Hex(
        JSON.stringify([
          pair.productAId,
          pair.productBId,
          identityData,
          input.fingerprint ?? null,
          input.producer
            ? [
                input.producer.kind,
                input.producer.model,
                input.producer.revision,
              ]
            : null,
        ]),
      );
      const publicationKey = `product-pair:${digest}`;
      const [published] = await client
        .select()
        .from(assessment)
        .where(eq(assessment.publicationKey, publicationKey))
        .limit(1);
      if (published) data = pairProjection.parse(published.evidence);
      const distinct =
        !data.actionable &&
        z
          .object({
            decision: z.object({ selectedIndex: z.number().nullable() }),
          })
          .safeParse(data.signals).data?.decision.selectedIndex === 1;
      // Exact suppression lookup is independent of queue limits and served policy.
      const [previous] = await client
        .select()
        .from(assessmentState)
        .where(
          and(
            eq(assessmentState.family, "product_pair"),
            eq(assessmentState.active, true),
            eq(assessmentState.recordId, pair.productAId),
            sql`${assessmentState.data}->>'otherId' = ${pair.productBId}`,
            or(
              eq(assessmentState.status, "pending"),
              sql`${assessmentState.suppression} IS NOT NULL`,
            ),
          ),
        )
        .limit(1);
      const old = previous
        ? {
            state: previous.suppression
              ? ("dismissed" as const)
              : ("open" as const),
          }
        : undefined;
      const prediction = await publishAssessment(
        transactionDb,
        {
          publicationKey,
          family: "product_pair",
          subject: {
            kind: "product_pair",
            entity: "product",
            recordId: pair.productAId,
            otherId: pair.productBId,
          },
          judgment: { actionable: data.actionable, conflict: data.conflict },
          producer:
            published?.producer ??
            input.producer ??
            (input.source === "agent"
              ? {
                  kind: "agent",
                  model: null,
                  revision: null,
                  runId: null,
                  evaluationId: null,
                }
              : null),
          evidence: data,
          fingerprint: input.fingerprint ?? null,
        },
        { data, ...(distinct ? { status: "resolved" } : {}) },
      );
      // A re-proposal replaces the earlier row; leaving it pending strands it.
      await client
        .update(assessmentState)
        .set({
          active: false,
          status: sql`CASE WHEN ${assessmentState.status} = ${suggestionStatus.enum.pending} THEN ${suggestionStatus.enum.superseded} ELSE ${assessmentState.status} END`,
        })
        .where(
          and(
            eq(assessmentState.family, "product_pair"),
            eq(assessmentState.recordId, pair.productAId),
            sql`${assessmentState.data}->>'otherId' = ${pair.productBId}`,
            sql`${assessmentState.id} <> ${prediction.id}`,
          ),
        );
      await client
        .update(assessmentState)
        .set({
          active: true,
          ...(old?.state === "dismissed"
            ? {
                suppression: {
                  scope: "product_pair",
                  candidateKey: productPairKey(
                    pair.productAId,
                    pair.productBId,
                  ),
                  fingerprint: null,
                },
                status: "resolved",
              }
            : {}),
        })
        .where(eq(assessmentState.id, prediction.id));
      return {
        ...pair,
        id: prediction.id,
        source: data.source,
        state: old?.state ?? "open",
        evidence: data.evidence,
        sourceUrls: data.sourceUrls,
        createdAt: prediction.createdAt,
        updatedAt: new Date(),
        fingerprint: input.fingerprint ?? null,
        actionable: data.actionable,
        conflict: data.conflict,
        verification:
          z
            .object({ verification: variantVerification.optional() })
            .safeParse(data.signals).data?.verification ?? "unknown",
        created: !old,
      };
    },
    config,
  );
}
/**
 * An agent proposal claims the two records are one item, not one snapshot of
 * them, so enrichment never retires it: it is fingerprinted live and a merge
 * pins what the member reviewed. Detector judgments keep their snapshot.
 */
export async function reviewedProductPairFingerprint(
  db: Database,
  state: { recordId: string; data: unknown; fingerprint: string | null },
) {
  const data = pairProjection.safeParse(state.data).data;
  if (data?.source !== "agent") return state.fingerprint;
  const { productPairFingerprint } =
    await import("./product-identity-snapshot");
  return productPairFingerprint(db, [
    parseEntityId("product", state.recordId),
    data.otherId,
  ]);
}
export async function upsertAgentProductMatch(
  db: Database | DrizzleTransaction,
  input: {
    productIds: readonly [ProductId, ProductId];
    evidence: string;
    sourceUrls: string[];
  },
) {
  const database = "select" in db ? databaseForTransaction(db) : db;
  const { prepareProductIdentityPair } =
    await import("./product-identity-snapshot");
  const prepared = await prepareProductIdentityPair(database, input.productIds);
  if (!prepared) throw new Error("Product identity target no longer exists");
  return publishProductPair(database, {
    ...input,
    source: "agent",
    fingerprint: prepared.fingerprint,
    conflict: prepared.conflict,
    actionable: prepared.exact,
    signals: z.json().parse({
      snapshots: [prepared.first, prepared.second],
      exact: prepared.exact,
      admissionRevision: PRODUCT_IDENTITY_RULE_REVISION,
    }),
  });
}
export async function listProductMatchRows(
  db: Database,
  productId?: ProductId,
  options: {
    reviewableOnly?: boolean;
    actionableOnly?: boolean;
    candidateId?: ProductId;
    limit?: number;
  } = {},
): Promise<ProductMatchCandidateRow[]> {
  const rows = await getDb(db)
    .select(getTableColumns(assessmentState))
    .from(assessmentState)
    .innerJoin(assessment, eq(assessment.id, assessmentState.id))
    .where(
      and(
        eq(assessmentState.family, "product_pair"),
        eq(assessmentState.active, true),
        sql`(${assessment.producer} IS NULL OR ${assessment.producer}->>${assessmentProducer.keyof().enum.kind} = ${assessmentProducer.shape.kind.enum.agent} OR (${assessment.producer}->>${assessmentProducer.keyof().enum.kind} = ${assessmentProducer.shape.kind.enum.rule} AND ${assessment.producer}->>'revision' = ${PRODUCT_IDENTITY_RULE_REVISION}) OR (${assessment.producer}->>${assessmentProducer.keyof().enum.kind} = ${assessmentProducer.shape.kind.enum.model} AND ${assessment.producer}->>'revision' = ${PRODUCT_IDENTITY_FEATURE.promptVersion}))`,
        options.reviewableOnly
          ? and(
              eq(assessmentState.status, "pending"),
              isNull(assessmentState.suppression),
            )
          : or(
              eq(assessmentState.status, "pending"),
              sql`${assessmentState.suppression} IS NOT NULL`,
            ),
        options.actionableOnly
          ? sql`${assessmentState.data}->>'actionable' = 'true'`
          : undefined,
        options.candidateId
          ? or(
              eq(assessmentState.recordId, options.candidateId),
              sql`${assessmentState.data}->>'otherId' = ${options.candidateId}`,
            )
          : undefined,
        productId
          ? or(
              eq(assessmentState.recordId, productId),
              sql`${assessmentState.data}->>'otherId' = ${productId}`,
            )
          : undefined,
      ),
    )
    .orderBy(
      sql`(${assessmentState.data}->>${pairProjection.keyof().enum.source} = ${pairProjection.shape.source.enum.agent}) DESC`,
      sql`(${assessmentState.data}->>'actionable')::boolean DESC`,
      assessmentState.id,
    )
    .limit(options.limit ?? 2147483647);
  return Promise.all(
    rows.map(async (row) => {
      const data = pairProjection.parse(row.data);
      return pairRow.parse({
        ...row,
        fingerprint: await reviewedProductPairFingerprint(db, row),
        productAId: row.recordId,
        productBId: data.otherId,
        source: data.source,
        state: row.suppression ? "dismissed" : "open",
        evidence: data.evidence,
        sourceUrls: data.sourceUrls,
        actionable: data.actionable,
        conflict: data.conflict,
        verification:
          z
            .object({ verification: variantVerification.optional() })
            .safeParse(data.signals).data?.verification ?? "unknown",
        signals: data.signals,
      });
    }),
  );
}
/** Repoint only current projections. Self-pair actions retire; original subjects never change. */
export async function repointProductMatchCandidatesTx(
  tx: DrizzleTransaction,
  keepId: ProductId,
  loserIds: readonly ProductId[],
) {
  if (!loserIds.length) return;
  const rows = await tx
    .select()
    .from(assessmentState)
    .where(
      and(
        eq(assessmentState.family, "product_pair"),
        eq(assessmentState.active, true),
        or(
          inArray(assessmentState.recordId, [...loserIds]),
          inArray(sql`${assessmentState.data}->>'otherId'`, [...loserIds]),
        ),
      ),
    );
  for (const row of rows) {
    const data = pairProjection.parse(row.data);
    const a = loserIds.some((id) => id === row.recordId)
      ? keepId
      : parseEntityId("product", row.recordId);
    const b = loserIds.includes(data.otherId) ? keepId : data.otherId;
    if (a === b)
      await tx
        .update(assessmentState)
        .set({ active: false, status: "superseded", suppression: null })
        .where(eq(assessmentState.id, row.id));
    else {
      const pair = canonicalProductPair(a, b);
      await tx
        .update(assessmentState)
        .set({
          recordId: pair.productAId,
          data: { ...data, otherId: pair.productBId },
          status: "superseded",
          fingerprint: null,
        })
        .where(eq(assessmentState.id, row.id));
    }
  }
}
