import { suggestionStatus } from "@cubby/schemas/ai";
import { suggestionSupersessionReceipt } from "@cubby/schemas/ai-evaluation";
import { assessmentFamily } from "@cubby/schemas/assessment";
import { derivedRefreshConnectionCursor } from "@cubby/schemas/derived-refresh";
import { sha256Hex } from "@cubby/shared/sha256";
import { eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { getDb, withTransactionDatabase } from "~/server/db/helpers";
import { derivedRefreshCursor, entityIdentity } from "~/server/db/schema";
import {
  connectionBasisIsCurrent,
  connectionReadEvidence,
  connectionReadEvidenceSql,
  forEachConnectionBasis,
} from "~/server/domains/connection/repo/connection-evidence";
import { canonicalJson } from "~/server/lib/canonical-json";

import {
  assertInputRevision,
  currentInputRevision,
  DerivedInputsChanged,
} from "./freshness";

const KEY = "derived-refresh:connections";
// A single source may own thousands of proposals. Page actual assessments,
// independently of source count, and never transfer their retained snapshots.
const PAGE = 16;
const rowsSchema = z.array(
  z.object({
    id: z.uuid(),
    family: z.enum(["field", "recommendation"]),
    fingerprint: z.string().nullable(),
    evidence: z.unknown(),
    dataHash: z.string(),
  }),
);

async function readCursor(db: Database) {
  const [row] = await getDb(db)
    .select({ cursor: derivedRefreshCursor.cursor })
    .from(derivedRefreshCursor)
    .where(eq(derivedRefreshCursor.key, KEY))
    .limit(1);
  return row?.cursor ? derivedRefreshConnectionCursor.parse(row.cursor) : null;
}

export async function nextConnectionRetirementWake(db: Database) {
  const cursor = await readCursor(db);
  return !cursor ||
    cursor.after !== null ||
    cursor.completedFingerprint !== String(await currentInputRevision(db))
    ? new Date()
    : null;
}

/** Prepare outside publication locks; finish the epoch before restarting after edits. */
export async function processConnectionRetirementPage(db: Database) {
  const before = await readCursor(db);
  const revision = await currentInputRevision(db);
  const current = String(revision);
  if (before?.after === null && before.completedFingerprint === current)
    return { done: true, processed: 0 };
  const cursor = before?.after
    ? before
    : {
        phase: "connections" as const,
        after: null,
        inputFingerprint: current,
        completedFingerprint: before?.completedFingerprint ?? null,
      };
  const result = await getDb(db).execute(sql`SELECT s.id, s.family,
    a.fingerprint, md5(s.data::text) AS "dataHash",
    CASE WHEN s.family=${assessmentFamily.enum.recommendation} THEN ${connectionReadEvidenceSql(sql`a.evidence`)}
      ELSE ${connectionReadEvidenceSql(sql`s.data->'connectionEvidence'`)} END AS evidence
    FROM "AssessmentState" s JOIN "Assessment" a ON a.id=s.id
    WHERE s.active AND s.status=${suggestionStatus.enum.pending}
      AND ((s.family=${assessmentFamily.enum.recommendation} AND a.subject->>'scope' LIKE 'connection.%')
        OR (s.family=${assessmentFamily.enum.field} AND s.data ? 'connectionEvidence'))
      ${cursor.after ? sql`AND s.id>${cursor.after}::uuid` : sql``}
    ORDER BY s.id LIMIT ${PAGE}`);
  const rows = rowsSchema.parse(result.rows);
  const targets = rows.filter(
    (row) => !connectionReadEvidence.safeParse(row.evidence).success,
  );
  const entries = rows.flatMap((row) => {
    const evidence = connectionReadEvidence.safeParse(row.evidence);
    return evidence.success
      ? [{ ...row, candidate: evidence.data.candidate }]
      : [];
  });
  const codes = [
    ...new Set(
      entries.flatMap((row) => [
        row.candidate.source.entityId,
        row.candidate.target.entityId,
      ]),
    ),
  ];
  const live = codes.length
    ? await getDb(db)
        .select({ kind: entityIdentity.kind, code: entityIdentity.shortcode })
        .from(entityIdentity)
        .where(
          sql`${inArray(entityIdentity.shortcode, codes)} AND ${entityIdentity.deletedAt} IS NULL AND ${entityIdentity.mergedIntoId} IS NULL`,
        )
    : [];
  const liveKeys = new Set(live.map((row) => `${row.kind}:${row.code}`));
  const eligible = entries.filter((row) => {
    const present = [row.candidate.source, row.candidate.target].every((ref) =>
      liveKeys.has(`${ref.entityKind}:${ref.entityId}`),
    );
    if (!present) targets.push(row);
    return present;
  });
  await forEachConnectionBasis(db, eligible, async (row, basis) => {
    const fresh =
      row.family === "field"
        ? await connectionBasisIsCurrent(db, row.id, basis)
        : row.fingerprint ===
          (await sha256Hex(
            canonicalJson({ version: 1, candidate: row.candidate, basis }),
          ));
    if (!fresh) targets.push(row);
  });
  const completed = rows.length < PAGE;
  try {
    return await withTransactionDatabase(db, async (tx) => {
      const client = getDb(tx);
      await client
        .insert(derivedRefreshCursor)
        .values({ key: KEY })
        .onConflictDoNothing();
      const [saved] = await client
        .select({ cursor: derivedRefreshCursor.cursor })
        .from(derivedRefreshCursor)
        .where(eq(derivedRefreshCursor.key, KEY))
        .for("update");
      const actual = saved?.cursor
        ? derivedRefreshConnectionCursor.parse(saved.cursor)
        : null;
      if (JSON.stringify(actual) !== JSON.stringify(before))
        return { done: false, processed: 0 };
      if (targets.length)
        await client.execute(sql`UPDATE "AssessmentState" s
        SET status=${suggestionStatus.enum.superseded}, "updatedAt"=now(), "supersessionReceipt"=jsonb_build_object(
          'reason',${suggestionSupersessionReceipt.shape.reason.enum.input_changed}::text,'evaluationId',NULL,'at',to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
        FROM (VALUES ${sql.join(
          targets.map((row) => sql`(${row.id}::uuid, ${row.dataHash}::text)`),
          sql`, `,
        )}) v(id,hash)
        WHERE s.id=v.id AND s.active AND s.status=${suggestionStatus.enum.pending} AND md5(s.data::text)=v.hash`);
      // Outputs precede the short input fence, matching the normal refresh lock order.
      await assertInputRevision(tx, revision);
      await client
        .update(derivedRefreshCursor)
        .set({
          cursor: {
            ...cursor,
            after: completed ? null : rows.at(-1)!.id,
            completedFingerprint: completed
              ? cursor.inputFingerprint
              : cursor.completedFingerprint,
          },
        })
        .where(eq(derivedRefreshCursor.key, KEY));
      return {
        done: completed && cursor.inputFingerprint === current,
        processed: rows.length,
      };
    });
  } catch (error) {
    if (error instanceof DerivedInputsChanged)
      return { done: false, processed: 0 };
    throw error;
  }
}
