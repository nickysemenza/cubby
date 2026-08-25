import type { BrowserRoutedEntity } from "@cubby/schemas/entity-manifest";
import type { QueryKey } from "@tanstack/react-query";
import { useMemo } from "react";
import { entityDialogLabel as labelFor } from "~/entities/entities";
import {
  entityMutationOptionsFactory,
  isGeneratedBrowserCrudEntity,
} from "~/entities/entity-contracts";
import type { GeneratedBrowserCrudEntity } from "~/entities/generated/entity-routes.gen";
import { imageDeleteMutationOptions } from "~/entities/image.functions";
import { invalidatesFor } from "~/lib/query-keys";

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
  invalidateKeys: readonly QueryKey[];
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
  invalidateKeys,
  entity,
}: {
  mutationFn: (callbacks: {
    onSuccess: () => void;
    onError: (err: { message?: string }) => void;
  }) => T;
  /** Dialog noun. Defaults to the entity's registry label. */
  entityLabel?: string;
  /**
   * Override the fan-out. Omit it — the default is the entity's own
   * `invalidatesFor(entity)` set. Both are
   * module-level constants, so either way the memo below stays stable.
   */
  invalidateKeys?: readonly QueryKey[];
  /** Entity slug — picks the registered-command delete path vs the legacy mutation. */
  entity: DeletableEntity;
}) {
  const label = entityLabel ?? labelFor(entity);
  const keys = invalidateKeys ?? invalidatesFor(entity);
  return useMemo(
    () => ({
      mutationOptions: mutationFn,
      entityLabel: label,
      invalidateKeys: keys,
      entity,
    }),
    // `label`/`keys` are constants (a registry string and a frozen key array),
    // so they never churn this memo — see the fan-out table's stability note.
    [mutationFn, label, keys, entity],
  );
}

/**
 * A list hook's delete affordance, resolved.
 *
 * `true` means the entity's own Start-backed delete plus its base invalidation
 * fan-out. A config is used as given; `undefined` means no delete.
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
        invalidateKeys: invalidatesFor(entity),
        entity,
      };
    }
    if (entity === "image") {
      return {
        mutationOptions: (callbacks: {
          onSuccess: () => void;
          onError: (err: { message?: string }) => void;
        }) => ({ ...imageDeleteMutationOptions(), ...callbacks }),
        entityLabel: labelFor(entity),
        invalidateKeys: invalidatesFor(entity),
        entity,
      };
    }
    return undefined;
  }, [entity]);
  return deletable === true ? fromContract : deletable;
}
