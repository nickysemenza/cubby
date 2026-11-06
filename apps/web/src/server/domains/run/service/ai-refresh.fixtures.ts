import {
  readAiDiscoveryCursor,
  saveAiDiscoveryCursor,
} from "~/server/ai/repo/ai-refresh";
import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { aiEvaluation } from "~/server/db/schema";
import { AUTOMATIC_EVALUATION_BACKLOG } from "~/server/domains/run/repo/ai-refresh-state";

import { discoverAiRefresh } from "./ai-refresh";

/** Run a discovery page now, as if a finished pass's hour had passed. */
export async function discoverAiRefreshNow(
  db: Database,
  ports?: Parameters<typeof discoverAiRefresh>[1],
) {
  await saveAiDiscoveryCursor(db, {
    ...(await readAiDiscoveryCursor(db)),
    completedAt: null,
  });
  return discoverAiRefresh(db, ports);
}

/** Owed automatic work at the cap, due far enough ahead that nothing claims it. */
export const fillAutomaticBacklog = (db: Database) =>
  getDb(db)
    .insert(aiEvaluation)
    .values(
      Array.from({ length: AUTOMATIC_EVALUATION_BACKLOG }, (_, index) => ({
        workKey: `synthetic-backlog-${index}`,
        feature: "synthetic-backlog",
        target: {
          kind: "connection" as const,
          entity: "task" as const,
          recordId: crypto.randomUUID(),
          field: null,
          suggestionIds: [],
        },
        provenance: {
          dependencies: [],
          inputFingerprint: `synthetic-backlog-${index}`,
          optionFingerprint: "synthetic",
          model: null,
        },
        snapshot: {},
        state: "queued" as const,
        executionKind: "ai_refresh" as const,
        runAt: new Date(Date.now() + 86_400_000),
      })),
    )
    .returning({ id: aiEvaluation.id });
