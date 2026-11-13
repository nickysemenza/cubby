import { workQueueContract } from "~/contracts/work-queue.contract";
import {
  readRecordWorkQueue,
  readWorkQueue,
} from "~/server/domains/work/service/work-queue-read";
import { readWorkStatus } from "~/server/domains/work/service/work-status";
import { implementOperationDomain } from "~/server/operation-runtime/operation-domain.server";

export const workQueueHandlers = implementOperationDomain(workQueueContract, {
  status: async (context) =>
    readWorkStatus(
      context.db,
      new Date(),
      // Loaded on demand: the drain registry imports every background handler.
      (await import("~/server/workflows/jobs")).productionDrainDues(),
    ),
  // Agents see shared work and work routed only to their own member.
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
