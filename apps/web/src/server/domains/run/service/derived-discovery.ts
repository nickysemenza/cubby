import { runEntityId } from "@cubby/schemas/identifiers";
import { jobWaitReason } from "@cubby/schemas/job";
import { z } from "zod";

import { readAiRefreshActivation } from "~/server/ai/repo/ai-refresh";
import type { Database } from "~/server/db";
import {
  CONNECTION_DISCOVERY_PENDING_CAP,
  CONNECTION_ROSTER_PAGE,
  pendingConnectionEvaluations,
} from "~/server/domains/run/repo/connection-refresh";
import {
  claimDerivedDiscovery,
  prepareConnectionDiscoveryPage,
} from "~/server/domains/run/repo/derived-discovery";
import { defineJobHandler } from "~/server/generic/jobs/service/jobs";
import { launchWorkflowRun } from "~/server/workflows/runs/lifecycle";

// Evaluation settlements release backpressure through the existing Job wake.
// One-hour retry is only the backstop for a missed release, not an idle poll.
const DISCOVERY_BACKPRESSURE_MS = 60 * 60_000;

const cursorSchema = z.object({
  after: z.string().nullable(),
  // A pass already under way when its Run was retired; launched once so it can finish.
  runId: runEntityId.nullable().default(null),
});

/** The routine connection discovery pass. Its Job owns the pass, and its work has no Run. */
export const connectionDiscoveryJobHandler = defineJobHandler(
  z.object({}),
  async (db, claim, _input, context) => {
    const activation = await readAiRefreshActivation(db);
    if (!activation?.enabled || !activation.manifest["entity-connections"])
      return { page: { done: true, result: { outcome: "disabled" } } };
    const previous = cursorSchema.parse(claim.cursor ?? { after: null });
    // Backpressure: hold the cursor until the evaluation backlog drains.
    if (
      (await pendingConnectionEvaluations(db)) >=
      CONNECTION_DISCOVERY_PENDING_CAP
    )
      return {
        page: {
          done: false,
          cursor: previous,
          waitUntil: new Date(Date.now() + DISCOVERY_BACKPRESSURE_MS),
          waitReason: jobWaitReason.enum.rate_limit,
        },
      };
    const page = await prepareConnectionDiscoveryPage(context.fenced, {
      after: previous.after,
      limit: CONNECTION_ROSTER_PAGE,
      newestFirst: true,
    });
    // Stopped by a member, or a sibling is admitting: the pass keeps its place.
    if (page.held)
      return {
        page: {
          done: false,
          cursor: previous,
          waitUntil: new Date(Date.now() + DISCOVERY_BACKPRESSURE_MS),
        },
      };
    return {
      page: {
        done: !page.next,
        ...(page.next
          ? { cursor: { after: page.next, runId: previous.runId } }
          : { result: { outcome: page.inserted ? "admitted" : "nothing" } }),
      },
      publish: async (tx) => {
        if (!page.next && previous.runId)
          await launchWorkflowRun(tx, {
            runId: previous.runId,
            purpose: "connection_discovery",
            automatic: true,
          });
      },
    };
  },
);

export async function scheduleDerivedDiscovery(db: Database) {
  await claimDerivedDiscovery(db);
  // Recovery sends one wake after all admission families have committed.
}
