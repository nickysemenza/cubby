import { suggestionStatus } from "@cubby/schemas/ai";
import { dateTime } from "@cubby/schemas/codec";
import {
  parseEntityId,
  productId,
  type ProductId,
} from "@cubby/schemas/identifiers";
import {
  suggestionChildHandle,
  suggestionProducer,
  type SuggestionProducer,
} from "@cubby/schemas/suggestion";
import { sha256Hex } from "@cubby/shared/sha256";
import {
  and,
  eq,
  inArray,
  isNotNull,
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
import { uuidArrayParam } from "~/server/db/helpers/query";
import { suggestionTable } from "~/server/db/schema";
import { variantVerification } from "~/server/domains/product/repo/product-variant-evidence";
import {
  publishSuggestionSet,
  type SuggestionFamily,
} from "~/server/generic/suggestions/repo/suggestion-publication";
import {
  suggestionRecordId,
  transitionSuggestionState,
} from "~/server/generic/suggestions/repo/suggestion-state";
import { WorkEvidenceObsoleteError } from "~/server/kernel/work-errors";

import { productIdentityEvidenceFences } from "./product-identity-fence";
import {
  pairFingerprint,
  prepareProductIdentityPair,
  preparedProductIdentityPair,
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
  id: suggestionChildHandle,
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
export const currentProductPairPolicy = (producer: SuggestionProducer | null) =>
  !producer ||
  producer.kind === "agent" ||
  (producer.kind === "rule" &&
    producer.revision === PRODUCT_IDENTITY_RULE_REVISION) ||
  (producer.kind === "model" &&
    producer.revision === PRODUCT_IDENTITY_FEATURE.promptVersion);

export const currentProductPairPolicySql = (producer: SQL) =>
  sql`(${producer} IS NULL OR ${producer}->>${suggestionProducer.keyof().enum.kind} = ${suggestionProducer.shape.kind.enum.agent} OR (${producer}->>${suggestionProducer.keyof().enum.kind} = ${suggestionProducer.shape.kind.enum.rule} AND ${producer}->>'revision' = ${PRODUCT_IDENTITY_RULE_REVISION}) OR (${producer}->>${suggestionProducer.keyof().enum.kind} = ${suggestionProducer.shape.kind.enum.model} AND ${producer}->>'revision' = ${PRODUCT_IDENTITY_FEATURE.promptVersion}))`;

export type ProductPairPublicationInput = {
  productIds: readonly [ProductId, ProductId];
  source: "agent" | "detector";
  evidence: string | null;
  sourceUrls: string[];
  signals?: z.infer<typeof pairProjection>["signals"];
  actionable?: boolean;
  conflict?: boolean;
  fingerprint?: string | null;
  producer?: SuggestionProducer;
};
type PreparedProductPairPublication = {
  key: string;
  input: ProductPairPublicationInput;
  pair: z.infer<typeof preparedProductIdentityPair>;
  fence: string;
};
type ProductPairPublicationResult =
  | { key: string; valid: false; row: null }
  | {
      key: string;
      valid: true;
      row: ProductMatchCandidateRow & { created: boolean };
    };

type ProductPairEntry = {
  key: string;
  input: ProductPairPublicationInput;
  pair: { productAId: ProductId; productBId: ProductId };
  data: z.infer<typeof pairProjection>;
  prior: typeof suggestionTable.$inferSelect | undefined;
  distinct: boolean;
  publicationKey: string;
  /** The pair's earlier open projection, set under the slot lock. */
  open?: { dismissed: boolean };
};

/** Each entry stores its own producer; this one only steers matching. */
const pairPublisher: SuggestionProducer = {
  kind: "agent",
  model: null,
  revision: null,
  runId: null,
  evaluationId: null,
};

const pairSuppression = (key: string) => ({
  scope: "product_pair",
  candidateKey: key,
  fingerprint: null,
});

/**
 * The `product_pair` family: one slot per unordered Product pair. A key names
 * exact evidence, so a replay keeps its row; a member's dismissal carries to
 * the replacement, and earlier rows stay as history. A non-actionable distinct
 * verdict publishes resolved, never pending.
 */
const productPairSuggestions: SuggestionFamily<ProductPairEntry> = {
  family: "product_pair",
  slot: ({ key, pair }) => ({
    lock: `product-pair-state:${key}`,
    fields: { recordId: pair.productAId, otherId: pair.productBId },
  }),
  fingerprint: ({ publicationKey }) => publicationKey,
  evidenceFingerprint: ({ publicationKey }) => publicationKey,
  suppresses: () => false,
  obsolete: () => true,
  onUnchanged: "none",
  replaced: "deactivate",
  prepare: async (_tx, entry, rows, producer) => {
    const open = rows.filter(
      (row) =>
        row.active &&
        (row.status === suggestionStatus.enum.pending ||
          row.suppression !== null),
    );
    return {
      candidate: {
        ...entry,
        ...(open.length && {
          open: { dismissed: open.some((row) => row.suppression !== null) },
        }),
      },
      producer,
    };
  },
  publication: ({ input, pair, data, prior, distinct, publicationKey }) => ({
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
        (input.source === "agent" ? { ...pairPublisher } : null),
      evidence: data,
      fingerprint: input.fingerprint ?? null,
    },
    projection: {
      data,
      ...(distinct ? { status: "resolved" as const } : {}),
    },
  }),
  afterPublish: async (tx, published) => {
    for (const { suggestionId, candidate } of published)
      await transitionSuggestionState(tx, suggestionId, {
        active: true,
        ...(candidate.open?.dismissed && {
          suppression: pairSuppression(candidate.key),
          status: "resolved",
        }),
      });
  },
  labelBacklog: sql`false`,
};

/** Caller owns the short SERIALIZABLE transaction and its Job/request guards.
 * One pair lock order, immutable publication and locked state read serve the
 * whole chunk. Duplicate source requests retain separate keyed results.
 */
async function publishProductPairPublications(
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
    .from(suggestionTable)
    .where(
      inArray(
        suggestionTable.publicationKey,
        prepared.map((entry) => entry.publicationKey),
      ),
    );
  const publishedByKey = new Map(
    published.map((row) => [row.publicationKey, row]),
  );
  const entries: ProductPairEntry[] = prepared.map((entry) => {
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
  const outcomesByEntry = await publishSuggestionSet(
    tx,
    productPairSuggestions,
    entries,
    pairPublisher,
  );
  const byPair = new Map(
    entries.map((entry, index) => {
      const outcome = outcomesByEntry[index];
      if (outcome?.outcome !== "published")
        throw new Error("Product pair publication returned no row");
      return [
        entry.key,
        { ...entry, prediction: outcome.row, open: outcome.candidate.open },
      ];
    }),
  );
  const validKeys = new Set(valid.map((outcome) => outcome.key));
  return outcomes.map(({ key, input }) => {
    const entry = byPair.get(productPairKey(...input.productIds));
    if (!validKeys.has(key) || !entry) return { key, valid: false, row: null };
    const { data, pair, prediction } = entry;
    const prior = entry.open;
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
    if (!pair)
      throw new WorkEvidenceObsoleteError(
        "Product identity target no longer exists",
      );
    const key = productPairKey(...input.productIds);
    const fences = await productIdentityEvidenceFences(tx, [
      { key, productIds: input.productIds },
    ]);
    const [result] = await publishProductPairPublications(tx, [
      { key, input, pair, fence: fences.get(key) ?? "" },
    ]);
    if (!result?.valid)
      throw new WorkEvidenceObsoleteError(
        "Product pair evidence changed during inference",
      );
    return result.row;
  });
}
/**
 * An agent proposal claims the two records are one item, not one snapshot of
 * them, so enrichment never retires it: it is fingerprinted live and a merge
 * pins what the member reviewed. Detector judgments keep their snapshot.
 */
/**
 * The live pair fingerprint, or null when the pair cannot apply. A detector
 * judgment holds only while its stored snapshot equals the live one, so
 * changed identity facts hide and refuse it on every surface.
 */
export async function productPairApplicationKey(
  db: Database,
  state: { recordId: string | null; data: unknown; fingerprint: string | null },
) {
  const data = pairProjection.safeParse(state.data).data;
  if (!data) return state.fingerprint;
  const { productPairFingerprint } =
    await import("./product-identity-snapshot");
  const live = await productPairFingerprint(db, [
    parseEntityId("product", suggestionRecordId(state)),
    data.otherId,
  ]);
  return data.source === "agent" || live === state.fingerprint ? live : null;
}

/**
 * A pair's identity facts as reviewed beside the current ones, per Product
 * field. Pairs published without snapshots compare the pair fingerprint.
 */
export async function productPairApplicationTerms(
  db: Database,
  state: { recordId: string | null; data: unknown; fingerprint: string | null },
) {
  const data = pairProjection.parse(state.data);
  const sides = [
    ["product", parseEntityId("product", suggestionRecordId(state))],
    ["otherProduct", data.otherId],
  ] as const;
  const { pairFingerprint, productIdentitySnapshots } =
    await import("./product-identity-snapshot");
  const current = await productIdentitySnapshots(
    db,
    sides.map(([, id]) => id),
  );
  const reviewed = z
    .object({ snapshots: z.array(z.record(z.string(), z.json())) })
    .safeParse(data.signals).data?.snapshots;
  if (!reviewed) {
    const [first, second] = sides.map(([, id]) => current.get(id)?.fingerprint);
    return {
      reviewed: { identity: state.fingerprint },
      current: {
        identity:
          first && second ? await pairFingerprint([first, second]) : null,
      },
    };
  }
  const terms = (
    snapshot: (id: ProductId) => z.infer<ReturnType<typeof z.json>> | undefined,
  ) =>
    Object.fromEntries(
      sides.flatMap(([side, id]) => {
        const facts = z
          .record(z.string(), z.json())
          .safeParse(snapshot(id)).data;
        return facts
          ? Object.entries(facts).map(([field, value]) => [
              `${side}.${field}`,
              value,
            ])
          : [[side, null]];
      }),
    );
  return {
    reviewed: terms((id) => reviewed.find((snapshot) => snapshot.id === id)),
    current: terms((id) => current.get(id)?.snapshot),
  };
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
  if (!prepared)
    throw new WorkEvidenceObsoleteError(
      "Product identity target no longer exists",
    );
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
    suggestionIds?: readonly string[];
    candidateId?: ProductId;
    limit?: number;
  } = {},
): Promise<ProductMatchCandidateRow[]> {
  const rows = await getDb(db)
    .select(getTableColumns(suggestionTable))
    .from(suggestionTable)
    .where(
      and(
        eq(suggestionTable.family, "product_pair"),
        eq(suggestionTable.active, true),

        options.suggestionIds
          ? sql`${suggestionTable.id} = ANY(${uuidArrayParam(options.suggestionIds)})`
          : undefined,
        currentProductPairPolicySql(sql`${suggestionTable.producer}`),
        options.reviewableOnly
          ? and(
              eq(suggestionTable.status, "pending"),
              isNull(suggestionTable.suppression),
            )
          : or(
              eq(suggestionTable.status, "pending"),
              isNotNull(suggestionTable.suppression),
            ),
        options.actionableOnly
          ? sql`${suggestionTable.data}->>'actionable' = 'true'`
          : undefined,
        options.candidateId
          ? or(
              eq(suggestionTable.recordId, options.candidateId),
              sql`${suggestionTable.data}->>'otherId' = ${options.candidateId}`,
            )
          : undefined,
        productId
          ? or(
              eq(suggestionTable.recordId, productId),
              sql`${suggestionTable.data}->>'otherId' = ${productId}`,
            )
          : undefined,
      ),
    )
    .orderBy(
      sql`(${suggestionTable.data}->>${pairProjection.keyof().enum.source} = ${pairProjection.shape.source.enum.agent}) DESC`,
      sql`(${suggestionTable.data}->>'actionable')::boolean DESC`,
      suggestionTable.id,
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
    .from(suggestionTable)
    .where(
      and(
        eq(suggestionTable.family, "product_pair"),
        eq(suggestionTable.active, true),
        or(
          inArray(suggestionTable.recordId, [...loserIds]),
          inArray(sql`${suggestionTable.data}->>'otherId'`, [...loserIds]),
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
    await transitionSuggestionState(
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
    );
  }
}
