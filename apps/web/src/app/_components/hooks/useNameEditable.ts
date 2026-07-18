import { useMemo } from "react";

/**
 * Builds `useEntityList`'s `nameEditable` config from an update mutation's
 * `mutateAsync`. Memoized on `mutateAsync` alone (no `[]` + biome-ignore
 * needed) — TanStack Query binds `mutateAsync` once per mutation-observer
 * instance in the component, so the reference is stable across re-renders
 * even though the mutation object itself is recreated every render.
 */
export function useNameEditable<TEntity extends { id: string }>(
  mutateAsync: (variables: {
    id: TEntity["id"];
    data: { name: string };
  }) => Promise<unknown>,
) {
  return useMemo(
    () => ({
      onSave: async (newName: string, entity: TEntity) => {
        await mutateAsync({ id: entity.id, data: { name: newName } });
      },
    }),
    [mutateAsync],
  );
}
