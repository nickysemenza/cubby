import type { Entity } from "@cubby/schemas/entity";
import type { BrowserRoutedEntity } from "@cubby/schemas/entity-manifest";
import type { QueryKey } from "@tanstack/react-query";
import { useMemo } from "react";
import { entityDialogLabel as labelFor } from "~/entities/entities";
import { getEntityContract } from "~/entities/entity-contracts";
import { useTRPC } from "~/integrations/trpc/react";

/** The delete affordance a list hook needs: how to call it, what to call it,
 * and which caches it moves. */
export interface DeletableConfig {
  /** tRPC delete mutation options factory */
  mutationOptions: (callbacks: {
    onSuccess: () => void;
    onError: (err: { message?: string }) => void;
  }) => unknown;
  entityLabel: string;
  invalidateKeys: readonly QueryKey[];
  /** Entity slug — picks the registered-command delete path vs the legacy mutation. */
  entity: Entity;
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
   * `invalidatesFor(entity)` set, resolved through its contract. Both are
   * module-level constants, so either way the memo below stays stable.
   */
  invalidateKeys?: readonly QueryKey[];
  /** Entity slug — picks the registered-command delete path vs the legacy mutation. */
  entity: Entity;
}) {
  const label = entityLabel ?? labelFor(entity);
  const keys = invalidateKeys ?? getEntityContract(entity).invalidationKeys;
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
 * `true` means "the entity's own contract delete" — its `mutation.delete`, its
 * base invalidation fan-out, and its registry label — which is what every
 * top-level list page wants. A config is used as given (an entity whose
 * contract has no delete, or a page needing different copy). `undefined` means
 * NO delete: the embedded relationship ledgers rely on that, since deleting a
 * purchase out of a vendor's ledger is not what that row menu should offer.
 *
 * The result is memoized on module-level constants plus the context-stable tRPC
 * proxy, so it never churns `useOptimisticDelete`'s mutation-options memo.
 */
export function useContractDeletable(
  entity: BrowserRoutedEntity,
  deletable: DeletableConfig | true | undefined,
): DeletableConfig | undefined {
  const api = useTRPC();
  const contract = getEntityContract(entity);
  const contractDelete = contract.mutation.delete;
  const invalidateKeys = contract.invalidationKeys;
  const fromContract = useMemo(
    () =>
      contractDelete
        ? {
            mutationOptions: (callbacks: {
              onSuccess: () => void;
              onError: (err: { message?: string }) => void;
            }) => contractDelete(api, callbacks as never),
            entityLabel: labelFor(entity),
            invalidateKeys,
            entity: entity as Entity,
          }
        : undefined,
    [api, contractDelete, invalidateKeys, entity],
  );
  return deletable === true ? fromContract : deletable;
}
