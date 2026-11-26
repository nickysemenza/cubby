import { workQueueContract } from "~/contracts/work-queue.contract";
import { withTransactionDatabase } from "~/server/db/helpers";
import {
  readKernelDiagnostics,
  retryKernelWork,
} from "~/server/domains/work/repo/kernel-diagnostics";
import {
  readRecordWorkQueue,
  readWorkQueue,
} from "~/server/domains/work/service/work-queue-read";
import { readWorkStatus } from "~/server/domains/work/service/work-status";
import { startPass } from "~/server/kernel/api";
import { implementOperationDomain } from "~/server/operation-runtime/operation-domain.server";
import {
  mailboxDiscoveryPass,
  purchaseDiscoveryPass,
} from "~/server/workflows/purchase-discovery-pass";

export const workQueueHandlers = implementOperationDomain(workQueueContract, {
  diagnostics: (context) =>
    readKernelDiagnostics(context.db, context.actorContext),
  retry: (context, input) => {
    if (
      input.type !== "pass" ||
      input.kind !== purchaseDiscoveryPass.name ||
      input.key !== "default"
    )
      return retryKernelWork(context.db, input, context.actorContext);
    return withTransactionDatabase(context.db, async (tx) => {
      const result = await retryKernelWork(tx, input, context.actorContext);
      if (result.retried) await startPass(tx, mailboxDiscoveryPass);
      return result;
    });
  },
  status: async (context) =>
    readWorkStatus(context.db, new Date(), context.actorContext),
  // Browser-only source projection; MCP reads machinery.needsYou.
  queue: async (context, input) => {
    const read = {
      input,
      memberPartyId: (await context.currentParty())?.id ?? null,
      memberOnly: context.actorContext.channel === "mcp",
    };
    return readWorkQueue(context.db, read);
  },
  forRecord: async (context, input) =>
    readRecordWorkQueue(context.db, {
      id: input.id,
      memberPartyId: (await context.currentParty())?.id ?? null,
      memberOnly: false,
    }),
});
