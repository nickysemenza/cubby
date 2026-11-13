import { sql } from "drizzle-orm";
/** Synthetic paid-result fixtures go through the same Ask/Answer writer. */
import { z } from "zod";

import type { Database } from "~/server/db";
import { repositoryQueries } from "~/server/db/repository-access.boundary";

import { modelAskFor } from "./model-asks";
import type { AiAnalysisFeature } from "./policy/features";
import { readModelAnswer } from "./repo/model-answer";

export async function seedModelAnswer<T>(
  db: Database,
  key: {
    entityKind: string;
    entityId: string | null;
    feature: AiAnalysisFeature<T>;
    inputFingerprint: string;
  },
  result: T,
): Promise<T> {
  const kind = modelAskFor(key.feature);
  const value = key.feature.analysisSchema.parse(result);
  const artifact = z
    .object({ contentFingerprint: z.string(), guidance: z.string().nullable() })
    .safeParse(value);
  const input = {
    kind: "structured" as const,
    model: key.feature.model,
    request: {
      systemPrompts: [],
      messages: [{ role: "user" as const, content: "Synthetic model Answer" }],
    },
    revision: {
      subject: key.entityId,
      ...(artifact.success
        ? artifact.data
        : { fingerprint: key.inputFingerprint }),
    },
  };
  const { withAsk } = await import("~/server/kernel/api");
  await withAsk(
    db,
    {
      ...kind,
      admit: async () => {},
      produce: async () => ({
        output: {
          value: z.json().parse(JSON.parse(JSON.stringify(value))),
          model: key.feature.model,
        },
        model: key.feature.model,
      }),
    },
    input,
    {
      record: key.entityId
        ? { entity: key.entityKind, id: key.entityId }
        : undefined,
    },
  );
  const stored = await readModelAnswer(db, kind, input);
  if (key.entityKind === "location" && key.entityId && stored)
    await repositoryQueries(db).execute(sql`
    INSERT INTO "ScopeState" ("scopeKind", "scopeKey", version, rules, stage, gaps, inputs)
    VALUES (${"fields"}, ${`location:${key.entityId}`}, 1, ${"synthetic"}, ${"done"}, '[]'::jsonb, ${JSON.stringify([{ kind: "answer", inputHash: stored.inputHash }])}::jsonb)
    ON CONFLICT ("scopeKind", "scopeKey") DO UPDATE SET inputs=excluded.inputs`);
  return value;
}
