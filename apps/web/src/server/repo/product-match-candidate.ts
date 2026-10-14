import { type AssessmentProducer } from "@cubby/schemas/assessment";
import {
  parseEntityId,
  productId,
  type ProductId,
} from "@cubby/schemas/identifiers";
import { sha256Hex } from "@cubby/shared/sha256";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database, DrizzleTransaction } from "~/server/db";
import { assessment, assessmentState } from "~/server/db/schema";
import { publishAssessment } from "~/server/repo/assessment";
import {
  databaseForTransaction,
  getDb,
  withTransactionDatabase,
} from "~/server/repo/database-helpers";

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
  id: z.uuid(),
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
});
export type ProductMatchCandidateRow = z.infer<typeof pairRow>;
export const canonicalProductPair = (a: ProductId, b: ProductId) =>
  a < b ? { productAId: a, productBId: b } : { productAId: b, productBId: a };
export const productPairKey = (a: string, b: string): string =>
  a < b ? `${a}|${b}` : `${b}|${a}`;

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
  const pair = canonicalProductPair(...input.productIds);
  if (pair.productAId === pair.productBId)
    throw new Error("Cannot assess a Product against itself");
  const data = pairProjection.parse({ otherId: pair.productBId, ...input });
  const digest = await sha256Hex(
    JSON.stringify([
      pair.productAId,
      pair.productBId,
      data,
      input.fingerprint ?? null,
      input.producer
        ? [input.producer.kind, input.producer.model, input.producer.revision]
        : null,
    ]),
  );
  return withTransactionDatabase(db, async (transactionDb) => {
    const client = getDb(transactionDb);
    // Requesting Runs share one immutable publication for unchanged evidence.
    // Preserve the first actual producer when opposite scans race or retry.
    const publicationKey = `product-pair:${digest}`;
    await client.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${publicationKey}, 0))`,
    );
    const [published] = await client
      .select()
      .from(assessment)
      .where(eq(assessment.publicationKey, publicationKey))
      .limit(1);
    const previous = await listProductMatchRows(transactionDb, pair.productAId);
    const old = previous.find((row) => row.productBId === pair.productBId);
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
      { data },
    );
    await client
      .update(assessmentState)
      .set({ active: false })
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
                candidateKey: productPairKey(pair.productAId, pair.productBId),
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
      created: !old,
    };
  });
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
  const { productIdentitySnapshot } =
    await import("~/server/ai/product-identity");
  const snapshots = await Promise.all(
    input.productIds.map((id) => productIdentitySnapshot(database, id)),
  );
  if (snapshots.some((value) => !value))
    throw new Error("Product identity target no longer exists");
  const { canonicalJson } = await import("~/server/repo/entity-source");
  const fingerprint = await sha256Hex(
    canonicalJson(snapshots.map((value) => value!.fingerprint).sort()),
  );
  return publishProductPair(database, {
    ...input,
    source: "agent",
    fingerprint,
  });
}
export async function listProductMatchRows(
  db: Database,
  productId?: ProductId,
): Promise<ProductMatchCandidateRow[]> {
  const rows = await getDb(db)
    .select()
    .from(assessmentState)
    .where(
      and(
        eq(assessmentState.family, "product_pair"),
        eq(assessmentState.active, true),
        or(
          eq(assessmentState.status, "pending"),
          sql`${assessmentState.suppression} IS NOT NULL`,
        ),
        productId
          ? or(
              eq(assessmentState.recordId, productId),
              sql`${assessmentState.data}->>'otherId' = ${productId}`,
            )
          : undefined,
      ),
    );
  return rows.map((row) => {
    const data = pairProjection.parse(row.data);
    return pairRow.parse({
      ...row,
      productAId: row.recordId,
      productBId: data.otherId,
      source: data.source,
      state: row.suppression ? "dismissed" : "open",
      evidence: data.evidence,
      sourceUrls: data.sourceUrls,
      actionable: data.actionable,
      conflict: data.conflict,
    });
  });
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
