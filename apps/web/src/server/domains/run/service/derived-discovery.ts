import { readAiRefreshActivation } from "~/server/ai/repo/ai-refresh";
import {
  CONNECTION_DISCOVERY_PENDING_CAP,
  CONNECTION_ROSTER_PAGE,
  pendingConnectionEvaluations,
} from "~/server/domains/run/repo/connection-refresh";
import {
  connectionDiscoveryPage,
  prepareConnectionDiscoveryPage,
} from "~/server/domains/run/repo/derived-discovery";
import type { BackgroundDrain } from "~/server/generic/background/drains";
import { launchWorkflowRun } from "~/server/workflows/runs/lifecycle";

/** Automatic discovery owes one cursor, never a Sweep Run or a Job. */
export const connectionDiscoveryDrain: BackgroundDrain = {
  name: "connection-discovery",
  page: (db) =>
    connectionDiscoveryPage(db, async (tx, cursor, save) => {
      if (cursor.stopped) return { more: false, nextAt: null };
      const nextAt = new Date(Date.now() + 2 * 60_000);
      if (cursor.nextAt && Date.parse(cursor.nextAt) > Date.now())
        return { more: false, nextAt: new Date(cursor.nextAt) };
      const activation = await readAiRefreshActivation(tx);
      if (!activation?.enabled || !activation.manifest["entity-connections"])
        return { more: false, nextAt: null };
      if (
        (await pendingConnectionEvaluations(tx)) >=
        CONNECTION_DISCOVERY_PENDING_CAP
      ) {
        await save({ ...cursor, nextAt: nextAt.toISOString() });
        return { more: false, nextAt };
      }
      const page = await prepareConnectionDiscoveryPage((work) => work(tx), {
        after: cursor.after,
        limit: CONNECTION_ROSTER_PAGE,
        newestFirst: true,
      });
      if (page.held) {
        await save({ ...cursor, nextAt: nextAt.toISOString() });
        return { more: false, nextAt };
      }
      if (!page.next && cursor.runId)
        await launchWorkflowRun(tx, {
          runId: cursor.runId,
          purpose: "connection_discovery",
          automatic: true,
        });
      await save({
        stopped: false,
        error: null,
        after: page.next,
        runId: page.next ? cursor.runId : null,
        nextAt: page.next ? null : nextAt.toISOString(),
      });
      return { more: !!page.next, nextAt: page.next ? null : nextAt };
    }),
};
