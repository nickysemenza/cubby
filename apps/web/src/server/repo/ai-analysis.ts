import type { AiAnalysisEntityType } from "@cubby/schemas/ai";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { z } from "zod";

import type { AiAnalysisFeature } from "~/server/ai/features";
import type { Database } from "~/server/db";
import { aiAnalysis } from "~/server/db/schema";
import {
  getDb,
  insertAndReturn,
  notDeleted,
  updateAndReturn,
} from "~/server/repo/database-helpers";

interface AiAnalysisKey<T> {
  entityKind: AiAnalysisEntityType;
  entityId: string | null;
  feature: AiAnalysisFeature<T>;
  inputFingerprint: string;
}

export interface StoredAiAnalysis<T> {
  inputFingerprint: string;
  model: string;
  promptVersion: string;
  result: T;
  updatedAt: Date;
}

export async function listAiAnalysesForEntityFeature<T>(
  db: Database,
  input: {
    entityKind: AiAnalysisEntityType;
    entityId: string | null;
    feature: string;
    promptVersion: string;
    schema: z.ZodType<T>;
    limit?: number;
  },
): Promise<StoredAiAnalysis<T>[]> {
  const rows = await getDb(db).query.aiAnalysis.findMany({
    where: and(
      eq(aiAnalysis.entityKind, input.entityKind),
      input.entityId == null
        ? isNull(aiAnalysis.entityId)
        : eq(aiAnalysis.entityId, input.entityId),
      eq(aiAnalysis.feature, input.feature),
      eq(aiAnalysis.promptVersion, input.promptVersion),
      notDeleted(aiAnalysis),
    ),
    columns: {
      inputFingerprint: true,
      model: true,
      promptVersion: true,
      result: true,
      updatedAt: true,
    },
    orderBy: desc(aiAnalysis.updatedAt),
    limit: input.limit ?? 50,
  });

  return rows.flatMap((row) => {
    const parsed = input.schema.safeParse(row.result);
    if (!parsed.success) {
      console.warn("ai.analysis.invalid-stored-result", {
        entityKind: input.entityKind,
        entityId: input.entityId,
        feature: input.feature,
        model: row.model,
      });
      return [];
    }
    return [{ ...row, result: parsed.data }];
  });
}

const analysisWhere = <T>({
  entityKind,
  entityId,
  feature,
  inputFingerprint,
}: AiAnalysisKey<T>) =>
  and(
    eq(aiAnalysis.entityKind, entityKind),
    entityId == null
      ? isNull(aiAnalysis.entityId)
      : eq(aiAnalysis.entityId, entityId),
    eq(aiAnalysis.feature, feature.feature),
    eq(aiAnalysis.model, feature.model),
    eq(aiAnalysis.promptVersion, feature.promptVersion),
    eq(aiAnalysis.inputFingerprint, inputFingerprint),
    notDeleted(aiAnalysis),
  );

/**
 * The cached answer **and when it was produced**.
 *
 * A cache hit answers today's question with an older analysis, so a surface
 * that shows provenance needs the age as much as the value — "cache hit" alone
 * does not say whether the shelf was read this morning or in March, and the
 * location description and detection surfaces now label both.
 */
export async function getCachedAiAnalysisRecord<T>(
  db: Database,
  key: AiAnalysisKey<T>,
): Promise<{ result: T; analyzedAt: Date } | null> {
  const row = await getDb(db).query.aiAnalysis.findFirst({
    where: analysisWhere(key),
    columns: { result: true, updatedAt: true },
  });
  if (!row) return null;
  return {
    result: key.feature.analysisSchema.parse(row.result),
    analyzedAt: row.updatedAt,
  };
}

export async function upsertAiAnalysis<T>(
  db: Database,
  key: AiAnalysisKey<T>,
  result: T,
): Promise<T> {
  const parsed = key.feature.analysisSchema.parse(result);
  const where = analysisWhere(key);
  const existing = await getDb(db).query.aiAnalysis.findFirst({
    where,
    columns: { id: true },
  });

  if (existing) {
    await updateAndReturn(
      db,
      aiAnalysis,
      { result: parsed },
      eq(aiAnalysis.id, existing.id),
    );
    return parsed;
  }

  await insertAndReturn(db, aiAnalysis, {
    entityKind: key.entityKind,
    entityId: key.entityId,
    feature: key.feature.feature,
    model: key.feature.model,
    promptVersion: key.feature.promptVersion,
    inputFingerprint: key.inputFingerprint,
    result: parsed,
  });
  return parsed;
}
