import { workQueueContract } from "~/contracts/work-queue.contract";
import {
  readPublishedWorkQueue,
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
  // An agent reads its own member's queue live: shared work and work routed
  // only to it. The household web reads the last publication.
  queue: async (context, input) => {
    const read = {
      input,
      memberPartyId: (await context.currentParty())?.id ?? null,
      memberOnly: context.actorContext.channel === "mcp",
    };
    return read.memberOnly
      ? readWorkQueue(context.db, read)
      : readPublishedWorkQueue(context.db, read);
  },
  forRecord: async (context, input) =>
    readRecordWorkQueue(context.db, {
      id: input.id,
      memberPartyId: (await context.currentParty())?.id ?? null,
      memberOnly: false,
    }),
});
