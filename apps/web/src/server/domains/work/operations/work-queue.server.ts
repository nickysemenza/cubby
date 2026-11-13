import { workQueueContract } from "~/contracts/work-queue.contract";
import {
  readKernelDiagnostics,
  retryKernelWork,
} from "~/server/domains/work/repo/kernel-diagnostics";
import {
  readRecordWorkQueue,
  readWorkQueue,
} from "~/server/domains/work/service/work-queue-read";
import { readWorkStatus } from "~/server/domains/work/service/work-status";
import { implementOperationDomain } from "~/server/operation-runtime/operation-domain.server";

export const workQueueHandlers = implementOperationDomain(workQueueContract, {
  diagnostics: (context) => readKernelDiagnostics(context.db),
  retry: (context, input) => retryKernelWork(context.db, input),
  status: async (context) => readWorkStatus(context.db, new Date()),
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
