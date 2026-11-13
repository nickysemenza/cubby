import { runEntityId } from "@cubby/schemas/identifiers";
import { importRunAgentIdentity } from "@cubby/schemas/import-run-agent";
import { purchaseAgentEvent } from "@cubby/schemas/purchase-import";
import { z } from "zod";

import { getPurchaseDispatchHostEnv } from "~/server/cf-env";
import { deliverPurchaseDispatch } from "~/server/domains/purchase-agent/service/dispatch";
import { purchaseDispatchEnvironment } from "~/server/domains/purchase-import/operations/agent-services";
import { readRun } from "~/server/domains/run/repo/ai-work-state";
import { pendingFundingResumeAt } from "~/server/domains/run/repo/execution-context";
import { definePass } from "~/server/kernel/api";
import { ClaimLapsedError } from "~/server/kernel/claim";

const dispatchCursor = z.object({
  runId: z.uuid(),
  events: z.array(purchaseAgentEvent).default([]),
});

/** Six live coordinators, including their model turns, tools and lifecycle work. */
export const purchaseDispatchPass = definePass({
  name: "purchase.dispatch",
  claimLimit: { partition: "household.agent-turns", slots: 6 },
  async run(db, raw, claim) {
    const cursor = dispatchCursor.parse(raw);
    const env = getPurchaseDispatchHostEnv();
    if (!env)
      throw new Error("Purchase dispatch host environment is unavailable");
    const pending: Promise<unknown>[] = [];
    const host = purchaseDispatchEnvironment(
      env,
      {
        waitUntil: (work) => {
          pending.push(work);
        },
      },
      claim.token,
    );
    const runId = runEntityId.parse(cursor.runId);
    const scope = await host.run(cursor.runId).loadScope();
    const coordinator = host.coordinator(
      importRunAgentIdentity(cursor.runId, scope.purpose),
    );
    const token = claim.token;
    const heartbeat = setInterval(() => {
      void claim.renew().catch(() => {
        // SILENT: the next fence reports lost ownership.
      });
    }, 30_000);
    try {
      for (const event of cursor.events) {
        await claim.fence(db);
        await deliverPurchaseDispatch(event, host);
      }
      for (;;) {
        if (!(await claim.renew())) throw new ClaimLapsedError();
        const current = await readRun(db, runId);
        if (
          current?.status === "paused_auth" &&
          current.failureCode === "execution_limit"
        ) {
          const until = await pendingFundingResumeAt(db);
          return {
            cursor: { runId: cursor.runId, events: [] },
            done: false,
            availableAt: until ?? new Date(Date.now() + 60_000),
            waitCause: "funding",
          };
        }
        const working = await coordinator.work(token);
        await Promise.all(pending.splice(0));
        if (!working)
          return { cursor: { runId: cursor.runId, events: [] }, done: true };
        await new Promise((resolve) => setTimeout(resolve, 5_000));
      }
    } finally {
      clearInterval(heartbeat);
    }
  },
});
