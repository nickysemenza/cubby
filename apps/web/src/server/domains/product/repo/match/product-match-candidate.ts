import { suggestionStatus } from "@cubby/schemas/ai";
import {
  assessmentChildHandle,
  assessmentProducer,
  type AssessmentProducer,
} from "@cubby/schemas/assessment";
import { dateTime } from "@cubby/schemas/codec";
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
  type SQL,
} from "drizzle-orm";
import { z } from "zod";

import {
  PRODUCT_IDENTITY_FEATURE,
  PRODUCT_IDENTITY_RULE_REVISION,
} from "~/server/ai/policy/feature-identity";
import type { Database, DrizzleTransaction } from "~/server/db";
import {
  databaseForTransaction,
  isTransaction,
  getDb,
  withTransactionDatabase,
} from "~/server/db/helpers";
import { assessment, assessmentState } from "~/server/db/schema";
import { variantVerification } from "~/server/domains/product/repo/product-variant-evidence";
import { publishAssessments } from "~/server/generic/assessment/repo/assessment";
import {
  transitionAssessmentState,
  transitionAssessmentStateBatch,
  type AssessmentStatePatch,
} from "~/server/generic/assessment/repo/assessment-state";

import { productIdentityEvidenceFences } from "./product-identity-fence";
import {
  pairFingerprint,
  prepareProductIdentityPair,
  prepareProductIdentityPairs,
  preparedProductIdentityPair,
  productIdentityPairKey,
  productIdentitySnapshots,
} from "./product-identity-snapshot";

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
  createdAt: dateTime,
  updatedAt: dateTime,
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

export const currentProductPairPolicySql = (producer: SQL) =>
  sql`(${producer} IS NULL OR ${producer}->>${assessmentProducer.keyof().enum.kind} = ${assessmentProducer.shape.kind.enum.agent} OR (${producer}->>${assessmentProducer.keyof().enum.kind} = ${assessmentProducer.shape.kind.enum.rule} AND ${producer}->>'revision' = ${PRODUCT_IDENTITY_RULE_REVISION}) OR (${producer}->>${assessmentProducer.keyof().enum.kind} = ${assessmentProducer.shape.kind.enum.model} AND ${producer}->>'revision' = ${PRODUCT_IDENTITY_FEATURE.promptVersion}))`;

export type ProductPairPublicationInput = {
  productIds: readonly [ProductId, ProductId];
  source: "agent" | "detector";
  evidence: string | null;
  sourceUrls: string[];
  signals?: z.infer<typeof pairProjection>["signals"];
  actionable?: boolean;
  conflict?: boolean;
  fingerprint?: string | null;
  producer?: AssessmentProducer;
};
export type PreparedProductPairPublication = {
  key: string;
  input: ProductPairPublicationInput;
  pair: z.infer<typeof preparedProductIdentityPair>;
  fence: string;
};
export type ProductPairPublicationResult =
  | { key: string; valid: false; row: null }
  | {
      key: string;
      valid: true;
      row: ProductMatchCandidateRow & { created: boolean };
    };

/** Pure preparation on a root handle; one set of snapshots/history/fences. */
export async function prepareProductPairPublications(
  db: Database,
  inputs: readonly { key: string; input: ProductPairPublicationInput }[],
): Promise<PreparedProductPairPublication[]> {
  if (isTransaction(getDb(db)))
    throw new Error(
      "Product pair preparation requires a database outside a transaction",
    );
  const targets = inputs.map(({ key, input }) => ({
    key,
    productIds: input.productIds,
  }));
  const before = await productIdentityEvidenceFences(db, targets);
  const pairs = await prepareProductIdentityPairs(
    db,
    inputs.map(({ input }) => input.productIds),
  );
  const after = await productIdentityEvidenceFences(db, targets);
  return inputs.flatMap(({ key, input }) => {
    const pair = pairs.get(productIdentityPairKey(input.productIds)),
      fence = before.get(key);
    return pair &&
      fence &&
      fence === after.get(key) &&
      (!input.fingerprint || input.fingerprint === pair.fingerprint)
      ? [{ key, input, pair, fence }]
      : [];
  });
}

/** Caller owns the short SERIALIZABLE transaction and its Job/request guards.
 * One pair lock order, immutable publication and locked state read serve the
 * whole chunk. Duplicate source requests retain separate keyed results.
 */
export async function publishProductPairPublications(
  tx: Database,
  outcomes: readonly PreparedProductPairPublication[],
): Promise<ProductPairPublicationResult[]> {
  const client = getDb(tx);
  if (!isTransaction(client))
    throw new Error("Product pair chunk publication requires a transaction");
  if (outcomes.length > 25)
    throw new Error("Product pair publication chunk exceeds 25 outcomes");
  if (!outcomes.length) return [];
  const lockKeys = [
    ...new Set(
      outcomes.map(
        ({ input }) =>
          `product-pair-state:${productPairKey(...input.productIds)}`,
      ),
    ),
  ].sort();
  await client.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(key, 0)) FROM (SELECT unnest(ARRAY[${sql.join(
      lockKeys.map((key) => sql`${key}`),
      sql`, `,
    )}]::text[]) AS key ORDER BY key) ordered`,
  );
  const fences = await productIdentityEvidenceFences(
    tx,
    outcomes.map(({ key, input }) => ({ key, productIds: input.productIds })),
  );
  const valid = outcomes.filter(
    (outcome) =>
      fences.get(outcome.key) === outcome.fence &&
      (!outcome.input.fingerprint ||
        outcome.input.fingerprint === outcome.pair.fingerprint),
  );
  const unique = new Map<string, PreparedProductPairPublication>();
  for (const outcome of valid) {
    const key = productPairKey(...outcome.input.productIds);
    if (!unique.has(key)) unique.set(key, outcome);
  }
  const prepared = await Promise.all(
    [...unique].map(async ([key, { input, pair: guard }]) => {
      const pair = canonicalProductPair(...input.productIds);
      if (pair.productAId === pair.productBId)
        throw new Error("Cannot assess a Product against itself");
      const proposed = pairProjection.parse({
        otherId: pair.productBId,
        ...input,
      });
      const suppliedSignals =
        z.record(z.string(), z.json()).safeParse(proposed.signals).data ?? {};
      const data = pairProjection.parse({
        ...proposed,
        conflict: proposed.conflict || guard.conflict,
        evidence:
          guard.verification === "pending_verification"
            ? "A historical identity conflict remains unresolved"
            : proposed.evidence,
        signals: {
          ...suppliedSignals,
          verification: guard.verification,
          variantEvidence: guard.variantEvidence,
          conflictLineage: guard.priorConflictIds,
        },
      });
      const identityData = {
        ...data,
        signals: {
          ...suppliedSignals,
          conflictLineage: null,
          verification: guard.verification,
          variantEvidence: null,
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
      return {
        key,
        input,
        pair,
        data,
        publicationKey: `product-pair:${digest}`,
      };
    }),
  );
  if (!prepared.length)
    return outcomes.map(({ key }) => ({ key, valid: false, row: null }));
  const published = await client
    .select()
    .from(assessment)
    .where(
      inArray(
        assessment.publicationKey,
        prepared.map((entry) => entry.publicationKey),
      ),
    );
  const publishedByKey = new Map(
    published.map((row) => [row.publicationKey, row]),
  );
  const entries = prepared.map((entry) => {
    const prior = publishedByKey.get(entry.publicationKey);
    const data = prior ? pairProjection.parse(prior.evidence) : entry.data;
    const distinct =
      !data.actionable &&
      z
        .object({
          decision: z.object({ selectedIndex: z.number().nullable() }),
        })
        .safeParse(data.signals).data?.decision.selectedIndex === 1;
    return { ...entry, data, prior, distinct };
  });
  const predictions = await publishAssessments(
    tx,
    entries.map(({ input, pair, data, prior, distinct, publicationKey }) => ({
      input: {
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
          prior?.producer ??
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
      projection: {
        data,
        ...(distinct ? { status: "resolved" as const } : {}),
      },
    })),
  );
  const byPair = new Map(
    entries.map((entry, index) => {
      const prediction = predictions[index];
      if (!prediction)
        throw new Error("Product pair publication returned no row");
      return [entry.key, { ...entry, prediction }];
    }),
  );
  const priorByPair = new Map<string, { dismissed: boolean }>();
  await transitionAssessmentStateBatch(
    tx,
    and(
      eq(assessmentState.family, "product_pair"),
      sql`(${assessmentState.recordId}::text || '|' || (${assessmentState.data}->>'otherId')) IN (${sql.join(
        [...byPair.keys()].map((key) => sql`${key}`),
        sql`, `,
      )})`,
    ),
    (rows) => {
      for (const row of rows) {
        const key = productPairKey(
          row.recordId,
          pairProjection.parse(row.data).otherId,
        );
        const current = byPair.get(key);
        // A just-inserted state is not the earlier open projection. A replay is.
        if (
          current &&
          (current.prior || row.id !== current.prediction.id) &&
          row.active &&
          (row.status === "pending" || row.suppression)
        ) {
          const previous = priorByPair.get(key);
          priorByPair.set(key, {
            dismissed: Boolean(previous?.dismissed || row.suppression),
          });
        }
      }
      return rows.flatMap((row) => {
        const key = productPairKey(
          row.recordId,
          pairProjection.parse(row.data).otherId,
        );
        const current = byPair.get(key);
        if (!current) return [];
        const patch: AssessmentStatePatch =
          row.id === current.prediction.id
            ? {
                active: true,
                ...(priorByPair.get(key)?.dismissed
                  ? {
                      suppression: {
                        scope: "product_pair",
                        candidateKey: key,
                        fingerprint: null,
                      },
                      status: "resolved",
                    }
                  : {}),
              }
            : {
                active: false,
                ...(row.status === suggestionStatus.enum.pending
                  ? { status: suggestionStatus.enum.superseded }
                  : {}),
              };
        return [
          {
            id: row.id,
            patch,
            cause: {
              kind:
                row.id === current.prediction.id
                  ? "product_pair_republished"
                  : "superseded_by_publication",
            },
          },
        ];
      });
    },
  );
  const validKeys = new Set(valid.map((outcome) => outcome.key));
  return outcomes.map(({ key, input }) => {
    const entry = byPair.get(productPairKey(...input.productIds));
    if (!validKeys.has(key) || !entry) return { key, valid: false, row: null };
    const { data, pair, prediction } = entry;
    const prior = priorByPair.get(entry.key);
    return {
      key,
      valid: true,
      row: {
        ...pair,
        id: prediction.id,
        source: data.source,
        state: prior?.dismissed ? "dismissed" : "open",
        evidence: data.evidence,
        sourceUrls: data.sourceUrls,
        createdAt: prediction.createdAt,
        updatedAt: new Date(),
        fingerprint: entry.input.fingerprint ?? null,
        actionable: data.actionable,
        conflict: data.conflict,
        verification:
          z
            .object({ verification: variantVerification.optional() })
            .safeParse(data.signals).data?.verification ?? "unknown",
        created: !prior,
      },
    };
  });
}

export async function publishProductPair(
  db: Database,
  input: ProductPairPublicationInput,
): Promise<ProductMatchCandidateRow & { created: boolean }> {
  return withTransactionDatabase(db, async (tx) => {
    const pair = await prepareProductIdentityPair(tx, input.productIds);
    if (!pair) throw new Error("Product identity target no longer exists");
    const key = productPairKey(...input.productIds);
    const fences = await productIdentityEvidenceFences(tx, [
      { key, productIds: input.productIds },
    ]);
    const [result] = await publishProductPairPublications(tx, [
      { key, input, pair, fence: fences.get(key) ?? "" },
    ]);
    if (!result?.valid)
      throw new Error("Product pair evidence changed during inference");
    return result.row;
  });
}
export async function prepareProductPairPublication(
  db: Database,
  input: ProductPairPublicationInput,
) {
  const prepared = await prepareProductPairPublications(db, [
    { key: "target", input },
  ]);
  if (!prepared.length)
    throw new Error("Product pair evidence changed during inference");
  return (tx: Database) =>
    withTransactionDatabase(
      tx,
      async (transactionDb) => {
        const [result] = await publishProductPairPublications(
          transactionDb,
          prepared,
        );
        if (!result?.valid)
          throw new Error("Product pair evidence changed during inference");
        return result.row;
      },
      { isolationLevel: "serializable" },
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
    assessmentIds?: readonly string[];
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
        eq(assessment.served, true),
        options.assessmentIds
          ? sql`${assessmentState.id} IN (${sql.join(
              options.assessmentIds.map((id) => sql`${id}::uuid`),
              sql`, `,
            )})`
          : undefined,
        currentProductPairPolicySql(sql`${assessment.producer}`),
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
  // Open detector advice is hidden once either snapshot moved; agent rows
  // fingerprint live. One set-based snapshot read serves every pair.
  const pairs = rows.map((row) => {
    const data = pairProjection.parse(row.data);
    const ids = [parseEntityId("product", row.recordId), data.otherId] as const;
    const live =
      data.source === "agent" || (row.status === "pending" && !row.suppression);
    return { row, data, ids, live };
  });
  const snapshots = await productIdentitySnapshots(
    db,
    pairs.flatMap((pair) => (pair.live ? pair.ids : [])),
  );
  const current = (ids: readonly [ProductId, ProductId]) => {
    const [first, second] = ids.map((id) => snapshots.get(id)?.fingerprint);
    return first && second ? pairFingerprint([first, second]) : null;
  };
  const listed: ProductMatchCandidateRow[] = [];
  for (const { row, data, ids, live } of pairs) {
    const fingerprint = live ? await current(ids) : row.fingerprint;
    if (
      data.source !== "agent" &&
      live &&
      (fingerprint === null || fingerprint !== row.fingerprint)
    )
      continue;
    listed.push(
      pairRow.parse({
        ...row,
        fingerprint: data.source === "agent" ? fingerprint : row.fingerprint,
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
      }),
    );
  }
  return listed;
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
    const pair = a === b ? null : canonicalProductPair(a, b);
    await transitionAssessmentState(
      tx,
      row.id,
      pair
        ? {
            recordId: pair.productAId,
            data: { ...data, otherId: pair.productBId },
            status: "superseded",
            fingerprint: null,
          }
        : { active: false, status: "superseded", suppression: null },
      { kind: "target_merged" },
    );
  }
}
