import { workQueueContract } from "~/contracts/work-queue.contract";
import {
  readRecordWorkQueue,
  readWorkQueue,
} from "~/server/domains/work/service/work-queue-read";
import { implementOperationDomain } from "~/server/operation-runtime/operation-domain.server";

export const workQueueHandlers = implementOperationDomain(workQueueContract, {
  // An agent reads its own member's queue: shared work and work routed only
  // to it. The household web reads everything.
  queue: async (context, input) =>
    readWorkQueue(context.db, {
      input,
      memberPartyId: (await context.currentParty())?.id ?? null,
      memberOnly: context.actorContext.channel === "mcp",
    }),
  forRecord: async (context, input) =>
    readRecordWorkQueue(context.db, {
      id: input.id,
      memberPartyId: (await context.currentParty())?.id ?? null,
      memberOnly: false,
    }),
});
