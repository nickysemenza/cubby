import { createServerFn } from "@tanstack/react-start";
import { startOperation } from "~/integrations/tanstack-query/start-transport";
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

const entityMutationOperation = startOperation<
  EntityBrowserMutationInput,
  EntityBrowserMutationResult
>({
  operation: "entity.mutate",
  kind: "mutation",
  transport: (data, { signal, headers }) =>
    executeEntityMutationTransport({ data, signal, headers }),
  parse: (result) => result as EntityBrowserMutationResult,
});

export async function executeEntityMutation(options: {
  data: EntityBrowserMutationInput;
  signal?: AbortSignal;
}): Promise<EntityBrowserMutationResult> {
  const result = await entityMutationOperation
    .forEntity(options.data.entity)
    .call(options.data, { signal: options.signal });
  // Open the fresh-read window before any invalidation this mutation triggers
  // can re-read a stale replica.
  markFreshReads();
  return result;
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
