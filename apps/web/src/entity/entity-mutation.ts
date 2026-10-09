import type { MutationSideEffects } from "@cubby/schemas/mutation-side-effects";
import type { UseMutationOptions } from "@tanstack/react-query";
import { z } from "zod";

import { entityMutation } from "~/integrations/tanstack-query/generated/entity-mutation.gen";
import type {
  EntityBrowserMutationInput,
  EntityBrowserMutationResult,
} from "~/server/entity-kernel/contracts";

import type { EntityEditResultFor } from "./editing/intent-types";
import type { EditableEntity } from "./editing/types";
import { parseEntityMutationOutput } from "./generated/entity-mutation-results.gen";

const entityMutationResultInputSchema = z.unknown();
type EntityMutationResultInput = z.input<
  typeof entityMutationResultInputSchema
>;

export type MergeCommand = Extract<
  EntityBrowserMutationInput,
  { action: "merge" }
>;

const kernelMutationIdentity = ({
  mutationKey,
  meta,
}: {
  mutationKey?: readonly unknown[];
  meta?: UseMutationOptions["meta"];
}) => ({ mutationKey, meta });

/** Mutation options for one entity merge, resolving to the kernel result. */
export const entityMergeMutationOptions =
  <E extends MergeCommand["entity"]>(entity: E) =>
  (): UseMutationOptions<EntityMergeResult<E>, Error, MergeCommand> => {
    const operation = entityMutation.mutate.forEntity(entity);
    return {
      ...kernelMutationIdentity(operation.mutationOptions()),
      mutationFn: async (command) => {
        const result = await operation.call(command);
        if (result.action !== "merge" || result.entity !== entity)
          throw new Error("Entity mutation result did not match its command");
        // SAFETY: narrowed by `entity` above; TS cannot correlate the
        // generic parameter through the discriminated union.
        return result as EntityMergeResult<E>;
      },
    };
  };

export type EntityMergeResult<E extends MergeCommand["entity"]> = Extract<
  EntityBrowserMutationResult,
  { action: "merge"; entity: E }
>;

/** Recover the entity-specific output through the same schema that backs the kernel. */
function parseEntityMutationResultFor<E extends EditableEntity>(
  entity: E,
  value: EntityMutationResultInput,
): EntityEditResultFor<E>;
function parseEntityMutationResultFor(
  entity: EditableEntity,
  value: EntityMutationResultInput,
) {
  return parseEntityMutationOutput(entity, value);
}

export function parseEntityWriteResult<E extends EditableEntity>(
  entity: E,
  action: "create" | "update",
  result: EntityBrowserMutationResult,
): EntityEditResultFor<E> & { sideEffects: MutationSideEffects } {
  if (
    result.entity !== entity ||
    result.action !== action ||
    !("item" in result)
  )
    throw new Error("Entity mutation result did not match its command");
  return {
    ...parseEntityMutationResultFor(entity, result.item),
    sideEffects: result.sideEffects,
  };
}

export function countPrimaryDeletedReferences(
  result: Extract<EntityBrowserMutationResult, { action: "delete" }>,
) {
  return result.deletedReferences.filter(
    (reference) => reference.entity === result.entity,
  ).length;
}
