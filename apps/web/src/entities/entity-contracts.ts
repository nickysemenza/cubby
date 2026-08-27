import type { MutationSideEffects } from "@cubby/schemas/background-jobs";
import type { UseMutationOptions } from "@tanstack/react-query";
import type { z } from "zod";
import { entityRipple } from "~/integrations/tanstack-query/cache-tags";
import type { entityBrowserMutationCommandSchema } from "~/server/entity-kernel/contracts";
import {
  entityMutation,
  executeEntityMutation,
  flattenEntityMutationResult,
} from "./entity-mutation.functions";
import type { EntityDetailByEntity } from "./generated/entity-details.gen";
import {
  type GeneratedBrowserCrudEntity,
  generatedBrowserCrudEntities,
} from "./generated/entity-routes.gen";

/**
 * One descriptor per entity, built once. `forEntity` rebuilds the whole
 * descriptor (and re-registers its invalidation policy) on every call, and this
 * runs inside a render.
 */
const kernelOptionsByEntity = new Map<string, Record<string, unknown>>();

/**
 * Reparenting a location moves inventory, product and problem views, not just
 * the location tree — the fan-out `location.bulkUpdateParent` has always
 * declared. `entityRipple("location")` is the narrow one, so without this a
 * kernel-path reparent would leave those surfaces stale with nothing failing.
 */
const kernelOptionsFor = (entity: StandardEntity) => {
  const cached = kernelOptionsByEntity.get(entity);
  if (cached) return cached;
  const base = entityMutation.mutate
    .forEntity(entity)
    .mutationOptions() as Record<string, unknown>;
  const options = {
    ...base,
    // The kernel descriptor resolves its fan-out from the COMMAND's `entity`,
    // but these options are handed variables in the call site's own shape
    // (`{ id, data }`, or the create payload). Naming the entity's ripple here
    // is what lets the root MutationCache invalidate anything at all — before
    // this, `meta` was absent entirely and every entity CRUD write in the app
    // fell through to the legacy key path.
    meta: {
      ...(base.meta as object),
      // `entityRipple` and not a per-action branch: nothing reaches the
      // kernel's `bulkUpdate` for `location` — reparenting kept its workflow,
      // because the sweep passes more ids than the kernel accepts. A location
      // caller arriving here would need the wider `ripple.locationReparent`
      // (inventory + problems + search + dashboard), which is why the workflow
      // declares it.
      invalidates: entityRipple(entity),
    },
  };
  kernelOptionsByEntity.set(entity, options);
  return options;
};

function kernelMutationOptions(
  entity: StandardEntity,
  action: StandardAction,
  callbacks: unknown,
) {
  return {
    ...kernelOptionsFor(entity),
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
            : action === "bulkUpdate"
              ? { action, entity, ids: input.ids, data: input.data }
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

type StandardAction = "create" | "update" | "delete" | "bulkUpdate";
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
    : A extends "bulkUpdate"
      ? CommandFor<E, "bulkUpdate"> extends { data: infer Data }
        ? { ids: string[]; data: Data }
        : never
      : { ids: string[] };
type MutationDataFor<
  E extends StandardEntity,
  A extends StandardAction,
> = A extends "delete"
  ? { deleted: number; sideEffects: MutationSideEffects }
  : A extends "bulkUpdate"
    ? { updated: number; sideEffects: MutationSideEffects }
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
