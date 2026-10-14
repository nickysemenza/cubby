import { imageAnalysisHistoryOutput } from "@cubby/schemas/activity";
import {
  imageDescriptionAnalysis,
  imageDescriptionResult,
} from "@cubby/schemas/image-processing";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { aiAnalysis } from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";

import { getImageProcessingReadProjection } from "./image-processing";

const cursorSchema = z.object({ at: z.iso.datetime(), id: z.string() });

function decodeCursor(value?: string) {
  if (!value) return null;
  try {
    return cursorSchema.parse(JSON.parse(atob(value)));
  } catch {
    throw new Error("Invalid image analysis cursor");
  }
}

const encodeCursor = (at: string, id: string) =>
  btoa(JSON.stringify({ at, id }));

/** Every retained description analysis of one Image, newest first. */
export async function imageAnalysisHistory(
  db: Database,
  input: { id: string; cursor?: string; limit: number },
) {
  const imageId = await resolveOrThrow(db, "image", input.id);
  const predicate = and(
    eq(aiAnalysis.entityKind, "image"),
    eq(aiAnalysis.entityId, imageId),
    eq(aiAnalysis.feature, "image-description"),
    notDeleted(aiAnalysis),
  );
  const cursor = decodeCursor(input.cursor);
  const [rows, totals, current] = await Promise.all([
    getDb(db)
      .select()
      .from(aiAnalysis)
      .where(
        and(
          predicate,
          cursor
            ? sql`(date_trunc('milliseconds', ${aiAnalysis.createdAt}), ${aiAnalysis.id}) < (date_trunc('milliseconds', ${cursor.at}::timestamptz AT TIME ZONE 'UTC'), ${cursor.id}::uuid)`
            : undefined,
        ),
      )
      .orderBy(
        desc(sql`date_trunc('milliseconds', ${aiAnalysis.createdAt})`),
        desc(aiAnalysis.id),
      )
      .limit(input.limit + 1),
    getDb(db)
      .select({ total: sql<number>`count(*)::int` })
      .from(aiAnalysis)
      .where(predicate),
    getImageProcessingReadProjection(db, imageId),
  ]);
  const preferred = current.analyses.find((analysis) => analysis.preferred);
  const page = rows.slice(0, input.limit);
  const items: z.output<typeof imageDescriptionAnalysis>[] = [];
  const unparsed: Array<{
    provider: string | null;
    model: string | null;
    promptVersion: string;
    resultSchemaRevision: number | null;
    createdAt: string;
    rawResultJson: string;
    reason: string;
  }> = [];
  for (const row of page) {
    const result = imageDescriptionResult.safeParse(row.result);
    if (!result.success) {
      unparsed.push({
        provider: row.provider,
        model: row.model,
        promptVersion: row.promptVersion,
        resultSchemaRevision: row.resultSchemaRevision,
        createdAt: row.createdAt.toISOString(),
        rawResultJson: JSON.stringify(row.result),
        reason: result.error.issues.map((issue) => issue.message).join("; "),
      });
      continue;
    }
    const entry = imageDescriptionAnalysis.safeParse({
      provider: row.provider ?? "legacy",
      model: row.model,
      promptRevision: Number(row.promptVersion),
      resultSchemaRevision: row.resultSchemaRevision ?? 1,
      inputFingerprint: row.inputFingerprint,
      result: result.data,
      runtime: row.runtime,
      createdAt: row.createdAt.toISOString(),
      preferred:
        row.inputFingerprint === preferred?.inputFingerprint &&
        row.createdAt.toISOString() === preferred?.createdAt,
    });
    if (entry.success) {
      items.push(entry.data);
    } else {
      unparsed.push({
        provider: row.provider,
        model: row.model,
        promptVersion: row.promptVersion,
        resultSchemaRevision: row.resultSchemaRevision,
        createdAt: row.createdAt.toISOString(),
        rawResultJson: JSON.stringify(row.result),
        reason: entry.error.issues.map((issue) => issue.message).join("; "),
      });
    }
  }
  const last = page.at(-1);
  return imageAnalysisHistoryOutput.parse({
    items,
    unparsed,
    total: totals[0]?.total ?? 0,
    nextCursor:
      rows.length > input.limit && last
        ? encodeCursor(last.createdAt.toISOString(), last.id)
        : null,
  });
}
