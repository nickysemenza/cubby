import { dateTime } from "@cubby/schemas/codec";
import { systemActor } from "@cubby/schemas/context";
import { entitySchema } from "@cubby/schemas/entity";
import { productId, type ProductId } from "@cubby/schemas/identifiers";
import { decisionChannel } from "@cubby/schemas/kernel/stage";
import {
  suggestionChildHandle,
  type SuggestionProducer,
} from "@cubby/schemas/suggestion";
import { sql } from "drizzle-orm";
import { z } from "zod";

import type { Database, DrizzleTransaction } from "~/server/db";
import {
  databaseForTransaction,
  isTransaction,
  getDb,
} from "~/server/db/helpers";
import { decision } from "~/server/db/kernel-schema";
import { productIdentityObservation } from "~/server/db/schema";
import { variantVerification } from "~/server/domains/product/repo/product-variant-evidence";
import { hashCanonical, recordIdentity } from "~/server/kernel/keys";
import { jsonSnapshot } from "~/server/lib/canonical-json";

import {
  prepareProductIdentityPair,
  productIdentitySnapshots,
  pairFingerprint,
} from "./product-identity-snapshot";
import { productPairObservation } from "./product-pair-observation";

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
export const productPairKey = (a: string, b: string): string =>
  a < b ? `${a}|${b}` : `${b}|${a}`;
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

/** Publish accepted pair facts; member identity choices occupy independent decision slots. */
export async function publishProductPair(
  db: Database,
  input: ProductPairPublicationInput,
): Promise<ProductMatchCandidateRow & { created: boolean }> {
  const { append, evidenceRow, householdWrite, reconcileNow } =
    await import("~/server/kernel/api");
  const { productIdentityEvidence } = await import("./product-pair-evidence");
  return householdWrite(db, async (database) => {
    const pair = await prepareProductIdentityPair(database, input.productIds);
    if (!pair) throw new Error("Product identity target no longer exists");
    const ids = [...input.productIds].sort();
    const key = productPairKey(ids[0]!, ids[1]!);
    const payload = productPairObservation.parse({
      productPair: key,
      productIds: ids,
      data: {
        otherId: ids[1],
        source: input.source,
        evidence: input.evidence,
        sourceUrls: input.sourceUrls,
        signals: input.signals,
        actionable: input.actionable ?? false,
        conflict: input.conflict ?? false,
      },
      fingerprint: pair.fingerprint,
      producer: jsonSnapshot.parse(input.producer ?? null),
    });
    const id = recordIdentity(
      { kind: "productIdentity", key },
      "ProductIdentityObservation",
      await hashCanonical(payload),
    );
    const inserted = await append(database, [
      evidenceRow(productIdentityEvidence, {
        id,
        scopeKey: key,
        userId: systemActor().userId,
        payload: jsonSnapshot.parse(payload),
      }),
    ]);
    await reconcileNow(database, [{ kind: "productIdentity", key }]);
    const rows = await listProductMatchRows(database, undefined, {
      suggestionIds: [id],
    });
    const row = rows[0];
    if (!row) throw new Error("Product pair publication returned no row");
    return { ...row, created: inserted.length > 0 };
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
  const database = isTransaction(db) ? databaseForTransaction(db) : db;
  const prepared = await prepareProductIdentityPair(database, input.productIds);
  if (!prepared) throw new Error("Product identity target no longer exists");
  return publishProductPair(database, {
    ...input,
    source: "agent",
    fingerprint: prepared.fingerprint,
    actionable: true,
    conflict: prepared.conflict,
  });
}

export async function listProductMatchRows(
  db: Database,
  focus?: ProductId,
  options: {
    reviewableOnly?: boolean;
    actionableOnly?: boolean;
    suggestionIds?: readonly string[];
    candidateId?: ProductId;
    limit?: number;
  } = {},
): Promise<ProductMatchCandidateRow[]> {
  const facts = await getDb(db).select().from(productIdentityObservation);
  const choices = await getDb(db)
    .select()
    .from(decision)
    .where(
      sql`${decision.channel}=${decisionChannel.enum.identity} AND ${decision.subject} LIKE 'product:%'`,
    )
    .orderBy(sql`${decision.at} DESC, ${decision.id} DESC`);
  const parsed = facts.flatMap((row) => {
    const value = productPairObservation.safeParse(row.payload);
    return value.success ? [{ row, value: value.data }] : [];
  });
  const snapshots = await productIdentitySnapshots(
    db,
    parsed.flatMap(({ value }) => value.productIds),
  );
  const roster = z
    .object({
      rows: z.array(
        z.object({
          requested: z.string(),
          id: z.string(),
          deletedAt: z.coerce.date().nullable(),
        }),
      ),
    })
    .parse(
      await getDb(db).execute(sql`
   SELECT e.id::text AS requested,coalesce(c.id,e.id)::text AS id,CASE WHEN c.id IS NOT NULL THEN c."deletedAt" ELSE e."deletedAt" END AS "deletedAt"
   FROM "Entity" e LEFT JOIN "Entity" c ON c.id=e."mergedIntoId" WHERE e.kind=${entitySchema.enum.product}
 `),
    ).rows;
  const identities = new Map(
    roster.filter((row) => !row.deletedAt).map((row) => [row.requested, row]),
  );
  const out: ProductMatchCandidateRow[] = [];
  const listed = new Set<string>();
  for (const { row, value } of parsed.sort(
    (a, b) => b.row.createdAt.getTime() - a.row.createdAt.getTime(),
  )) {
    if (options.suggestionIds && !options.suggestionIds.includes(row.id))
      continue;
    const resolved = value.productIds.map((id) => identities.get(id));
    const a = resolved[0],
      b = resolved[1];
    if (!a || !b || a.id === b.id) continue;
    const key = productPairKey(a.id, b.id);
    if (!options.suggestionIds && listed.has(key)) continue;
    listed.add(key);
    if (focus && ![a.id, b.id].includes(focus)) continue;
    if (options.candidateId && ![a.id, b.id].includes(options.candidateId))
      continue;
    const held = choices.find(
      (d) =>
        [d.subject, d.other].includes(`product:${a.id}`) &&
        [d.subject, d.other].includes(`product:${b.id}`),
    );
    if (options.reviewableOnly && held) continue;
    if (options.actionableOnly && !value.data.actionable) continue;
    const prints = value.productIds.map((id) => snapshots.get(id)?.fingerprint);
    const fingerprint =
      prints[0] && prints[1]
        ? await pairFingerprint([prints[0], prints[1]])
        : null;
    if (
      value.data.source !== "agent" &&
      options.reviewableOnly &&
      fingerprint !== value.fingerprint
    )
      continue;
    out.push(
      pairRow.parse({
        id: row.id,
        productAId: a.id,
        productBId: b.id,
        ...value.data,
        state: held ? "dismissed" : "open",
        createdAt: row.createdAt,
        updatedAt: row.createdAt,
        fingerprint:
          value.data.source === "agent" ? fingerprint : value.fingerprint,
        verification:
          z
            .object({ verification: variantVerification.optional() })
            .safeParse(value.data.signals).data?.verification ?? "unknown",
      }),
    );
  }
  return out.slice(0, options.limit ?? out.length);
}
