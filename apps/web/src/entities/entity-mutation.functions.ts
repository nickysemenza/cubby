import { createServerFn } from "@tanstack/react-start";
import {
  observedStartCall,
  unwrapStartOperationResult,
} from "~/integrations/tanstack-query/start-transport";
import { markFreshReads } from "~/lib/fresh-read-marker";
import type {
  EntityBrowserMutationInput,
  EntityBrowserMutationResult,
} from "~/server/entity-kernel/contracts";
import * as entityRuntime from "~/server/entity-runtime.server";
import { authenticatedStartServerFunction } from "~/server/middleware/entity-server-functions";

const executeEntityMutationTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator((input: unknown) => input as EntityBrowserMutationInput)
  .handler(
    async ({ data, context }) =>
      await entityRuntime.executeEntityMutation({
        data,
        request: context.startOperation,
      }),
  );

export async function executeEntityMutation(options: {
  data: EntityBrowserMutationInput;
  signal?: AbortSignal;
}): Promise<EntityBrowserMutationResult> {
  return await observedStartCall({
    operation: "entity.mutate",
    kind: "mutation",
    entity: options.data.entity,
    input: options.data,
    call: async (headers) => {
      const result = unwrapStartOperationResult(
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

/** Restore the entity-shaped result existing form and editing callers consume. */
export function flattenEntityMutationResult(
  result: EntityBrowserMutationResult,
) {
  if ("item" in result)
    return { ...result.item, sideEffects: result.sideEffects };
  if (result.action === "delete")
    return { deleted: result.deleted, sideEffects: result.sideEffects };
  return result.result;
}
