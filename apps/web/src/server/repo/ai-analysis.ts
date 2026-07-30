import type { AiAnalysisEntityType } from "@cubby/schemas/ai";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { z } from "zod";
import type { AiFeature } from "~/server/ai/features";
import type { Database } from "~/server/db";
import { aiAnalysis } from "~/server/db/schema";
import {
  getDb,
  insertAndReturn,
  notDeleted,
  updateAndReturn,
} from "~/server/repo/database-helpers";

interface AiAnalysisKey<T> {
  entityType: AiAnalysisEntityType;
  entityId: string | null;
  feature: AiFeature<T>;
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
    entityType: AiAnalysisEntityType;
    entityId: string | null;
    feature: string;
    promptVersion: string;
    schema: z.ZodType<T>;
    limit?: number;
  },
): Promise<StoredAiAnalysis<T>[]> {
  const rows = await getDb(db).query.aiAnalysis.findMany({
    where: and(
      eq(aiAnalysis.entityType, input.entityType),
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
        entityType: input.entityType,
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
  entityType,
  entityId,
  feature,
  inputFingerprint,
}: AiAnalysisKey<T>) =>
  and(
    eq(aiAnalysis.entityType, entityType),
    entityId == null
      ? isNull(aiAnalysis.entityId)
      : eq(aiAnalysis.entityId, entityId),
    eq(aiAnalysis.feature, feature.feature),
    eq(aiAnalysis.model, feature.model),
    eq(aiAnalysis.promptVersion, feature.promptVersion),
    eq(aiAnalysis.inputFingerprint, inputFingerprint),
    notDeleted(aiAnalysis),
  );

export async function getCachedAiAnalysis<T>(
  db: Database,
  key: AiAnalysisKey<T>,
): Promise<T | null> {
  const row = await getDb(db).query.aiAnalysis.findFirst({
    where: analysisWhere(key),
    columns: { result: true },
  });
  if (!row) return null;
  return key.feature.schema.parse(row.result);
}

export async function upsertAiAnalysis<T>(
  db: Database,
  key: AiAnalysisKey<T>,
  result: T,
): Promise<T> {
  const parsed = key.feature.schema.parse(result);
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
    entityType: key.entityType,
    entityId: key.entityId,
    feature: key.feature.feature,
    model: key.feature.model,
    promptVersion: key.feature.promptVersion,
    inputFingerprint: key.inputFingerprint,
    result: parsed,
  });
  return parsed;
}

export function parseStoredAiAnalysis<T>(
  schema: z.ZodType<T>,
  result: unknown,
): T {
  return schema.parse(result);
}
