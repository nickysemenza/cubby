import type { EntityRef } from "@cubby/schemas/entity";
import { parseEntityId, parseShortcodeFor } from "@cubby/schemas/identifiers";
import { sha256Hex } from "@cubby/shared/sha256";
import { eq, sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import { getDb, notDeleted } from "~/server/db/helpers";
import { inventoryEntry } from "~/server/db/schema";
import { expenseProjectRecommendationContext } from "~/server/domains/expense/repo/project-recommendations";
import { getProductStockRows } from "~/server/domains/inventory/repo/scan";
import { canonicalJson } from "~/server/entity-kernel/repo/entity-source";
import { SHORTCODE_TABLE } from "~/server/generic/shortcode/repo/shortcode-tables";

import { retrieveConnectionCandidates } from "./connection-candidates";
import {
  captureConnectionBasis,
  connectionRecord,
  connectionRelevantFields,
  connectionRelevantRow,
  prepareConnectionBases,
  snapshotJson,
} from "./connection-evidence";
import { emailDiscoveryBasis } from "./email-connections";

// Field inference and semantic retrieval may select any live target in these
// corpora. Other families use their deterministic, source-scoped inputs below.
const targetCorpora = new Map<
  string,
  readonly (keyof typeof SHORTCODE_TABLE)[]
>(
  Object.entries({
    product: ["product", "purchase", "expense", "ingredient", "plant"],
    purchase: ["product"],
    expense: ["product"],
    task: ["product"],
    cookbook: ["product"],
    device: ["product"],
  }),
);

/** No inference or projection writes: safe for scheduling and publication fences. */
export async function connectionDiscoveryFingerprint(
  db: Database,
  source: EntityRef,
) {
  const record = await connectionRecord(db, source);
  const corpora = [];
  const kinds = targetCorpora.get(source.entityKind) ?? [];
  for (const kind of kinds) {
    const table = SHORTCODE_TABLE[kind];
    const indexed =
      ["product", "purchase", "expense"].includes(source.entityKind) &&
      ["product", "purchase", "expense"].includes(kind);
    const relevant = sql`jsonb_build_object(${sql.join(
      connectionRelevantFields(kind).flatMap((key) => [
        sql`${key}::text`,
        sql`to_jsonb(${table})->${key}::text`,
      ]),
      sql`, `,
    )})`;
    const projection = indexed
      ? sql`(SELECT d."sourceHash" FROM "SearchDocument" d
      WHERE d."entityId"=${table.id} AND d."entityKind"=${kind} AND d."deletedAt" IS NULL)`
      : sql`NULL`;
    // Reduce in Postgres; a sweep must not transfer each entire target corpus
    // to the Worker once for every source and publication fence.
    const [corpus] = await getDb(db)
      .select({
        fingerprint: sql<string>`md5(coalesce(jsonb_agg(
        jsonb_build_array(${table.id}, ${relevant}, ${projection}) ORDER BY ${table.id}
      ), '[]'::jsonb)::text)`,
      })
      .from(table)
      .where(notDeleted(table));
    corpora.push({ kind, fingerprint: corpus?.fingerprint ?? null });
  }
  const candidates = await retrieveConnectionCandidates(db, source);
  const prepared = await prepareConnectionBases(db, candidates);
  const bases = [];
  for (const candidate of candidates)
    bases.push({
      relation: candidate.relation,
      basis: await captureConnectionBasis(db, candidate, false, prepared),
    });
  let context: ReturnType<typeof snapshotJson> = null;
  if (source.entityKind === "expense") {
    const recommendation = await expenseProjectRecommendationContext(
      db,
      parseShortcodeFor("expense", source.entityId),
    );
    context = recommendation
      ? snapshotJson({
          ...recommendation,
          source: {
            ...connectionRelevantRow(
              "expense",
              snapshotJson(recommendation.source),
            ),
            productKind: recommendation.source.productKind,
          },
        })
      : null;
  }
  if (source.entityKind === "inventory") {
    const [stock] = await getDb(db)
      .select({ productId: inventoryEntry.productId })
      .from(inventoryEntry)
      .where(eq(inventoryEntry.id, parseEntityId("inventory", record.id)));
    context = stock
      ? snapshotJson(await getProductStockRows(db, stock.productId))
      : null;
  }
  const mail =
    source.entityKind === "email" || source.entityKind === "purchase"
      ? await emailDiscoveryBasis(db, source)
      : null;
  return sha256Hex(
    canonicalJson({ source: record.row, corpora, bases, context, mail }),
  );
}
