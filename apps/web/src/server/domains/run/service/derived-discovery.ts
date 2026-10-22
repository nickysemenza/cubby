import { aiRefreshRunInput } from "@cubby/schemas/ai-evaluation";
import { runEntityId } from "@cubby/schemas/identifiers";
import { z } from "zod";

import { readAiRefreshActivation } from "~/server/ai/repo/ai-refresh";
import type { Database } from "~/server/db";
import {
  claimDerivedDiscovery,
  prepareConnectionDiscoveryPage,
} from "~/server/domains/run/repo/derived-discovery";
import { ensureRun, systemActor } from "~/server/domains/run/repo/ensure-run";
import { defineJobHandler } from "~/server/generic/jobs/service/jobs";
import { wakeJobs } from "~/server/workflows/background-tasks/publish";
import { launchWorkflowRun } from "~/server/workflows/runs/lifecycle";

const cursorSchema = z.object({
  after: z.string().nullable(),
  runId: runEntityId,
});
export const connectionDiscoveryJobHandler = defineJobHandler(
  z.object({}),
  async (db, claim) => {
    const activation = await readAiRefreshActivation(db);
    if (!activation?.enabled || !activation.manifest["entity-connections"])
      return { page: { done: true, result: { outcome: "disabled" } } };
    const previous = claim.cursor ? cursorSchema.parse(claim.cursor) : null;
    const runId =
      previous?.runId ??
      (await ensureRun(db, systemActor(), {
        purpose: "ai_refresh",
        trigger: "scheduled",
        status: "running",
        execution: false,
        clientKey: `connection-discovery:${claim.id}:${claim.generation}`,
        input: aiRefreshRunInput.parse({ kind: "ai_refresh", activation }),
      }));
    const page = await prepareConnectionDiscoveryPage(db, {
      childRunId: runId,
      after: previous?.after ?? null,
      limit: 25,
    });
    return {
      page: {
        done: !page.next,
        ...(page.next ? { cursor: { after: page.next, runId } } : {}),
      },
      publish: async (tx) => {
        if (!page.next)
          await launchWorkflowRun(tx, {
            runId,
            purpose: "ai_refresh",
            automatic: true,
          });
      },
    };
  },
);

export async function scheduleDerivedDiscovery(db: Database) {
  await claimDerivedDiscovery(db);
  await wakeJobs({ source: "connection-discovery" });
}
