import { useMemo } from "react";

type EditableMutation<TEntity extends { id: string }, TData> = (variables: {
  id: TEntity["id"];
  data: TData;
}) => Promise<object>;

function useEditableField<TEntity extends { id: string }, TData>(
  mutateAsync: EditableMutation<TEntity, TData>,
  buildData: (newName: string) => TData,
) {
  return useMemo(
    () => ({
      onSave: async (newName: string, entity: TEntity) => {
        await mutateAsync({
          id: entity.id,
          data: buildData(newName),
        });
      },
    }),
    [mutateAsync, buildData],
  );
}

const buildNameUpdate = (name: string) => ({ name });
const buildFilenameUpdate = (filename: string) => ({ filename });

/**
 * Builds `useEntityList`'s `nameEditable` config from an update mutation's
 * `mutateAsync`. Memoized on `mutateAsync` and the stable payload builder (no
 * lint suppression needed) — TanStack Query binds `mutateAsync` once per
 * mutation-observer instance in the component, so the reference is stable
 * across re-renders even though the mutation object itself is recreated every
 * render.
 *
 * Entities whose editable label is not `name` use their field-specific hook,
 * keeping the mutation payload correlated without a computed-key assertion.
 */
export function useNameEditable<TEntity extends { id: string }>(
  mutateAsync: EditableMutation<TEntity, { name: string }>,
) {
  return useEditableField(mutateAsync, buildNameUpdate);
}

export function useFilenameEditable<TEntity extends { id: string }>(
  mutateAsync: EditableMutation<TEntity, { filename: string }>,
) {
  return useEditableField(mutateAsync, buildFilenameUpdate);
}
