import { workQueueContract } from "~/contracts/work-queue.contract";
import {
  readRecordWorkQueue,
  readWorkQueue,
} from "~/server/generic/work-queue/service/work-queue-read";
import { implementOperationDomain } from "~/server/operation-runtime/operation-domain.server";

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
