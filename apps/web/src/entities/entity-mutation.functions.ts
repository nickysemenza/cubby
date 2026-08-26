import { z } from "zod";
import {
  defineOperationDomain,
  mutation,
} from "~/integrations/tanstack-query/operation-catalog";
import type {
  EntityBrowserMutationInput,
  EntityBrowserMutationResult,
} from "~/server/entity-kernel/contracts";
import { ENTITY_BINDINGS } from "~/server/generated/entity-bindings.gen";
import type { EntityEditResultFor } from "./editing/intent-types";
import type { EditableEntity } from "./editing/types";

/** @lintignore Discovered by the operation registry generator. */
export const entityMutation = defineOperationDomain("entity", {
  mutate: mutation({
    input: z.custom<EntityBrowserMutationInput>(),
    output: z.custom<EntityBrowserMutationResult>(),
    invalidates: [["entity"]],
  }),
});

export async function executeEntityMutation(options: {
  data: EntityBrowserMutationInput;
  signal?: AbortSignal;
}): Promise<EntityBrowserMutationResult> {
  const result = await entityMutation.mutate
    .forEntity(options.data.entity)
    .call(options.data, { signal: options.signal });
  // Open the fresh-read window before any invalidation this mutation triggers
  // can re-read a stale replica.
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

/** Recover the entity-specific output through the same schema that backs the kernel. */
export function parseEntityMutationResultFor<E extends EditableEntity>(
  entity: E,
  value: unknown,
): EntityEditResultFor<E>;
export function parseEntityMutationResultFor(
  entity: EditableEntity,
  value: unknown,
) {
  const binding = ENTITY_BINDINGS[entity].crud;
  if (!binding) throw new Error(`${entity} has no CRUD output schema.`);
  return binding.output.parse(value);
}
