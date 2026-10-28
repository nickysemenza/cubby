import { runEntityId } from "@cubby/schemas/identifiers";
import { jobWaitReason } from "@cubby/schemas/job";
import { connectionDiscoveryRunInput } from "@cubby/schemas/run-fields";
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
import { ensureRun, systemActor } from "~/server/domains/run/repo/ensure-run";
import { defineJobHandler } from "~/server/generic/jobs/service/jobs";
import { wakeJobs } from "~/server/workflows/background-tasks/publish";
import { launchWorkflowRun } from "~/server/workflows/runs/lifecycle";

// Short: a full backlog drains within about a minute, and a longer wait idles
// the pass rather than the queue.
const DISCOVERY_BACKPRESSURE_MS = 30_000;

/**
 * A member's cancel of the pass's Run stops the pass until the next day's
 * routine pass; continuing under a new Run made Stop ineffective.
 */
const MEMBER_STOP_MS = 24 * 60 * 60_000;

const cursorSchema = z.object({
  after: z.string().nullable(),
  // Cursors from before lazy Run creation carry no runId.
  runId: runEntityId.nullable().default(null),
  // A stopped Run the pass continues from until a continuation Run opens.
  replacing: runEntityId.nullable().default(null),
});

/**
 * The routine connection discovery pass. Its Job owns the pass; the
 * `connection_discovery` Run appears only once a page admits work, and its
 * id rides in the Job cursor until the last page launches it.
 */
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
      runId: previous.runId,
      replacing: previous.replacing,
      after: previous.after,
      limit: CONNECTION_ROSTER_PAGE,
      newestFirst: true,
      createRun: (tx, replacing) =>
        ensureRun(tx, systemActor(), {
          purpose: "connection_discovery",
          trigger: "scheduled",
          status: "running",
          execution: false,
          clientKey: `connection-discovery:${claim.id}:${claim.generation}${replacing ? `:after:${replacing}` : ""}`,
          input: connectionDiscoveryRunInput.parse({
            kind: "connection_discovery",
            activation,
          }),
        }),
    });
    if (page.outcome === "member-stopped")
      return {
        page: {
          done: false,
          cursor: { after: null, runId: null, replacing: null },
          waitUntil: new Date(Date.now() + MEMBER_STOP_MS),
        },
      };
    return {
      page: {
        done: !page.next,
        ...(page.next
          ? {
              cursor: {
                after: page.next,
                runId: page.runId,
                replacing: page.replacing,
              },
            }
          : { result: { outcome: page.runId ? "admitted" : "nothing" } }),
      },
      publish: async (tx) => {
        if (!page.next && page.runId)
          await launchWorkflowRun(tx, {
            runId: page.runId,
            purpose: "connection_discovery",
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
