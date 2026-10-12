import { workQueueContract } from "~/contracts/work-queue.contract";
import { implementOperationDomain } from "~/server/operation-domain.server";
import { readWorkQueue } from "~/server/repo/work-queue";

export const workQueueHandlers = implementOperationDomain(workQueueContract, {
  list: async (context, input) =>
    readWorkQueue(
      context.db,
      (await context.currentParty())?.id ?? null,
      input,
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
