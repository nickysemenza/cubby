import { workQueueContract } from "~/contracts/work-queue.contract";
import { implementOperationDomain } from "~/server/operation-domain.server";
import { readRecordWorkQueue, readWorkQueue } from "~/server/repo/work-queue";

export const workQueueHandlers = implementOperationDomain(workQueueContract, {
  list: async (context, input) =>
    readWorkQueue(
      context.db,
      (await context.currentParty())?.id ?? null,
      input,
      false,
    ),
  forRecord: async (context, input) =>
    readRecordWorkQueue(
      context.db,
      (await context.currentParty())?.id ?? null,
      input.id,
      false,
    ),
  forMember: async (context, input) =>
    readWorkQueue(
      context.db,
      (await context.currentParty())?.id ?? null,
      { ...input, waitingFor: "me" },
      true,
    ),
});
