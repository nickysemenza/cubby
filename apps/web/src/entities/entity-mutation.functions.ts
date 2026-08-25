import { mutationOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { markFreshReads } from "~/lib/fresh-read-marker";
import {
  type EntityBrowserMutationCommand,
  type EntityBrowserMutationResult,
  entityBrowserMutationCommandSchema,
} from "~/server/entity-kernel/contracts";
import * as entityRuntime from "~/server/entity-runtime.server";
import { authenticatedEntityServerFunction } from "~/server/middleware/entity-server-functions";
import {
  observedEntityCall,
  unwrapEntityTransportResult,
} from "./entity-transport";

const executeEntityMutationTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedEntityServerFunction])
  .validator(entityBrowserMutationCommandSchema)
  .handler(
    async ({ data, context }) =>
      await entityRuntime.executeEntityMutation({
        data,
        request: context.entityRuntime,
      }),
  );

async function executeEntityMutation(options: {
  data: EntityBrowserMutationCommand;
  signal?: AbortSignal;
}): Promise<EntityBrowserMutationResult> {
  return await observedEntityCall({
    operation: "entity.mutate",
    kind: "mutation",
    entity: options.data.entity,
    input: options.data,
    call: async (headers) => {
      const result = unwrapEntityTransportResult(
        "entity.mutate",
        await executeEntityMutationTransport({
          data: options.data,
          signal: options.signal,
          headers,
        }),
      );
      markFreshReads();
      return result;
    },
  });
}

export function entityMutationOptions() {
  return mutationOptions({
    mutationKey: [["entity", "mutate"]] as const,
    meta: {
      transport: "start",
      operation: "entity.mutate",
      observedByTransport: true,
    },
    mutationFn: (command: EntityBrowserMutationCommand) =>
      executeEntityMutation({ data: command }),
  });
}
