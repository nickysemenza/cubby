import type { BrowserRoutedEntity } from "@cubby/schemas/entity-manifest";
import type { UseMutationOptions } from "@tanstack/react-query";
import { useMemo } from "react";

import { entityLabel as labelFor } from "~/entities/entities";
import {
  entityMutationOptionsFactory,
  isGeneratedBrowserCrudEntity,
} from "~/entities/entity-contracts";
import type { GeneratedBrowserCrudEntity } from "~/entities/generated/entity-routes.gen";
import { image } from "~/entities/image.functions";

type DeletableEntity = GeneratedBrowserCrudEntity | "image";

export interface DeleteMutationVariables {
  ids: string[];
}

/** Every delete reports how many rows its operation actually removed. */
export interface DeleteMutationResult {
  deleted: number;
}

export type DeleteMutationOptions = UseMutationOptions<
  DeleteMutationResult,
  Error,
  DeleteMutationVariables
>;

function normalizedDeleteMutationOptions<TData extends DeleteMutationResult>(
  options: UseMutationOptions<TData, Error, DeleteMutationVariables>,
): DeleteMutationOptions {
  const {
    mutationFn,
    onError: _onError,
    onMutate: _onMutate,
    onSettled: _onSettled,
    onSuccess: _onSuccess,
    ...base
  } = options;
  if (!mutationFn)
    throw new Error("Delete mutation options require mutationFn.");
  return {
    ...base,
    mutationFn: async (variables, context) => {
      const result = await mutationFn(variables, context);
      return { deleted: result.deleted };
    },
  };
}

/** The delete affordance a list hook needs: how to call it, what to call it,
 * and which caches it moves. */
export interface DeletableConfig {
  /** Delete mutation options factory. */
  mutationOptions: () => DeleteMutationOptions;
  entityLabel: string;
  /** Entity slug — picks the registered-command delete path vs the legacy mutation. */
  entity: DeletableEntity;
}

/**
 * Creates a stable deletable configuration for useEntityList.
 *
 * This hook prevents infinite render loops by memoizing the deletable config object,
 * which would otherwise be recreated on every render when passed inline to useEntityList.
 */
export function useDeletableConfig<TData extends DeleteMutationResult>({
  mutationFn,
  entityLabel,
  entity,
}: {
  mutationFn: (
    callbacks: Pick<
      UseMutationOptions<TData, Error, DeleteMutationVariables>,
      "onSuccess" | "onError"
    >,
  ) => UseMutationOptions<TData, Error, DeleteMutationVariables>;
  /** Dialog noun. Defaults to the entity's registry label. */
  entityLabel?: string;
  /** Entity slug — picks the registered-command delete path vs the legacy mutation. */
  entity: DeletableEntity;
}) {
  const label = entityLabel ?? labelFor(entity);
  return useMemo(
    () => ({
      mutationOptions: () => normalizedDeleteMutationOptions(mutationFn({})),
      entityLabel: label,
      entity,
    }),
    // `label` is a registry constant, so it never churns this memo.
    [mutationFn, label, entity],
  );
}

/**
 * A list hook's delete affordance, resolved.
 *
 * `true` means the entity's own Start-backed delete. A config is used as given;
 * `undefined` means no delete.
 */
export function useContractDeletable(
  entity: BrowserRoutedEntity,
  deletable: DeletableConfig | true | undefined,
): DeletableConfig | undefined {
  const fromContract = useMemo(() => {
    if (isGeneratedBrowserCrudEntity(entity)) {
      return {
        mutationOptions: () =>
          normalizedDeleteMutationOptions(
            entityMutationOptionsFactory(entity, "delete")({}),
          ),
        entityLabel: labelFor(entity),
        entity,
      };
    }
    if (entity === "image") {
      return {
        mutationOptions: () =>
          normalizedDeleteMutationOptions(image.delete.mutationOptions()),
        entityLabel: labelFor(entity),
        entity,
      };
    }
    return undefined;
  }, [entity]);
  return deletable === true ? fromContract : deletable;
}
