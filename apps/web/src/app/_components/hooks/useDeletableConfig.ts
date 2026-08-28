import type { BrowserRoutedEntity } from "@cubby/schemas/entity-manifest";
import { useMemo } from "react";

import { entityDialogLabel as labelFor } from "~/entities/entities";
import {
  entityMutationOptionsFactory,
  isGeneratedBrowserCrudEntity,
} from "~/entities/entity-contracts";
import type { GeneratedBrowserCrudEntity } from "~/entities/generated/entity-routes.gen";
import { image } from "~/entities/image.functions";

type DeletableEntity = GeneratedBrowserCrudEntity | "image";

/** The delete affordance a list hook needs: how to call it, what to call it,
 * and which caches it moves. */
export interface DeletableConfig {
  /** Delete mutation options factory. */
  mutationOptions: (callbacks: {
    onSuccess: () => void;
    onError: (err: { message?: string }) => void;
  }) => unknown;
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
export function useDeletableConfig<T>({
  mutationFn,
  entityLabel,
  entity,
}: {
  mutationFn: (callbacks: {
    onSuccess: () => void;
    onError: (err: { message?: string }) => void;
  }) => T;
  /** Dialog noun. Defaults to the entity's registry label. */
  entityLabel?: string;
  /** Entity slug — picks the registered-command delete path vs the legacy mutation. */
  entity: DeletableEntity;
}) {
  const label = entityLabel ?? labelFor(entity);
  return useMemo(
    () => ({
      mutationOptions: mutationFn,
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
        mutationOptions: entityMutationOptionsFactory(entity, "delete"),
        entityLabel: labelFor(entity),
        entity,
      };
    }
    if (entity === "image") {
      return {
        mutationOptions: (callbacks: {
          onSuccess: () => void;
          onError: (err: { message?: string }) => void;
        }) => ({ ...image.delete.mutationOptions(), ...callbacks }),
        entityLabel: labelFor(entity),
        entity,
      };
    }
    return undefined;
  }, [entity]);
  return deletable === true ? fromContract : deletable;
}
