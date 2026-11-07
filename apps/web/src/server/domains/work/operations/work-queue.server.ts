import { NEEDS_YOU_FILTERS, workQueueInput } from "@cubby/schemas/work-queue";

import { workQueueContract } from "~/contracts/work-queue.contract";
import {
  readRecordWorkQueue,
  readWorkQueue,
} from "~/server/domains/work/service/work-queue-read";
import { readWorkStatus } from "~/server/domains/work/service/work-status";
import { resolveFilterTokens } from "~/server/entity-kernel/filter-tokens";
import { implementOperationDomain } from "~/server/operation-runtime/operation-domain.server";

export const workQueueHandlers = implementOperationDomain(workQueueContract, {
  status: async (context) =>
    readWorkStatus(context.db, {
      // Internal queue reads need the same actor-filter resolution as public reads.
      input: await resolveFilterTokens(
        context,
        workQueueInput,
        workQueueInput.parse({ ...NEEDS_YOU_FILTERS, pageSize: 1 }),
      ),
      memberPartyId: (await context.currentParty())?.id ?? null,
      memberOnly: context.actorContext.channel === "mcp",
    }),
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
