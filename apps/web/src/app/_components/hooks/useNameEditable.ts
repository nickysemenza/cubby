import { useMemo } from "react";

/**
 * Builds `useEntityList`'s `nameEditable` config from an update mutation's
 * `mutateAsync`. Memoized on `mutateAsync` and `field` alone (no lint
 * suppression needed) — TanStack Query binds `mutateAsync` once per
 * mutation-observer instance in the component, so the reference is stable
 * across re-renders even though the mutation object itself is recreated every
 * render.
 *
 * `field` defaults to `"name"`; pass e.g. `"filename"` for entities (like
 * Image) whose editable label column isn't called `name` — generalized rather
 * than inlining a fresh `{ [field]: newName }` object literal at each call
 * site (that would be a fresh-object-into-a-hook-with-deps footgun).
 */
export function useNameEditable<
  TEntity extends { id: string },
  TField extends string = "name",
>(
  mutateAsync: (variables: {
    id: TEntity["id"];
    data: Record<TField, string>;
  }) => Promise<unknown>,
  field: TField = "name" as TField,
) {
  return useMemo(
    () => ({
      onSave: async (newName: string, entity: TEntity) => {
        await mutateAsync({
          id: entity.id,
          data: { [field]: newName } as Record<TField, string>,
        });
      },
    }),
    [mutateAsync, field],
  );
}
