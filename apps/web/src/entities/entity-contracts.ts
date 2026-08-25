import type { MutationSideEffects } from "@cubby/schemas/background-jobs";
import type { UseMutationOptions } from "@tanstack/react-query";
import type { z } from "zod";
import type { entityBrowserMutationCommandSchema } from "~/server/entity-kernel/contracts";
import {
  executeEntityMutation,
  flattenEntityMutationResult,
} from "./entity-mutation.functions";
import type { EntityDetailByEntity } from "./generated/entity-details.gen";
import {
  type GeneratedBrowserCrudEntity,
  generatedBrowserCrudEntities,
} from "./generated/entity-routes.gen";

function kernelMutationOptions(
  entity: StandardEntity,
  action: "create" | "update" | "delete",
  callbacks: unknown,
) {
  return {
    mutationKey: [["entity", "mutate"]] as const,
    ...(callbacks as Record<string, unknown>),
    mutationFn: async (variables: unknown) => {
      const input = variables as {
        id?: string;
        ids?: string[];
        data?: Record<string, unknown>;
      };
      const command =
        action === "create"
          ? { action, entity, data: variables as Record<string, unknown> }
          : action === "update"
            ? { action, entity, id: input.id, data: input.data }
            : { action, entity, ids: input.ids };
      const result = await executeEntityMutation({
        data: command as z.input<typeof entityBrowserMutationCommandSchema>,
      });
      return flattenEntityMutationResult(result);
    },
  };
}

type StandardEntity = GeneratedBrowserCrudEntity;

export const isGeneratedBrowserCrudEntity = (
  entity: string,
): entity is GeneratedBrowserCrudEntity =>
  (generatedBrowserCrudEntities as readonly string[]).includes(entity);

type StandardAction = "create" | "update" | "delete";
type CommandFor<
  E extends StandardEntity,
  A extends Exclude<StandardAction, "delete">,
> = Extract<
  z.input<typeof entityBrowserMutationCommandSchema>,
  { entity: E; action: A }
>;
type VariablesFor<
  E extends StandardEntity,
  A extends StandardAction,
> = A extends "create"
  ? CommandFor<E, "create"> extends { data: infer Data }
    ? Data
    : never
  : A extends "update"
    ? CommandFor<E, "update"> extends { id: infer Id; data: infer Data }
      ? { id: Id; data: Data }
      : never
    : { ids: string[] };
type MutationDataFor<
  E extends StandardEntity,
  A extends StandardAction,
> = A extends "delete"
  ? { deleted: number; sideEffects: MutationSideEffects }
  : EntityDetailByEntity[E] & { sideEffects: MutationSideEffects };

/** Typed Start mutation-options factory for compiled CRUD entities. */
export function entityMutationOptionsFactory<
  E extends StandardEntity,
  A extends StandardAction,
>(entity: E, action: A) {
  return (
    callbacks: Omit<
      UseMutationOptions<MutationDataFor<E, A>, Error, VariablesFor<E, A>>,
      "mutationFn" | "mutationKey"
    > = {},
  ) =>
    kernelMutationOptions(
      entity,
      action,
      callbacks,
    ) as unknown as UseMutationOptions<
      MutationDataFor<E, A>,
      Error,
      VariablesFor<E, A>
    >;
}
