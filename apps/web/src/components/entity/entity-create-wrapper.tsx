import type { ReactNode } from "react";
import { useEntityCreateMode } from "~/app/_components/hooks/useEntityMode";
import type { EditableEntity } from "~/entities/editing";

interface CreateModeProps<TResult> {
  isPending: boolean;
  error: string | undefined;
  onCreate: (data: unknown) => void;
  onCreateAsync: (data: unknown) => Promise<TResult>;
  onCancel: () => void;
}

interface EntityCreateWrapperProps<TResult extends { id: string }> {
  entity: EditableEntity;
  mutationOptions: object;
  children: (props: CreateModeProps<TResult>) => ReactNode;
}

export function EntityCreateWrapper<TData, TResult extends { id: string }>({
  entity,
  mutationOptions,
  children,
}: EntityCreateWrapperProps<TResult>) {
  const { error, isPending, handleCreate, handleCreateAsync, handleCancel } =
    useEntityCreateMode<TData, TResult>(entity, mutationOptions);

  return children({
    isPending,
    error,
    onCreate: handleCreate as (data: unknown) => void,
    onCreateAsync: handleCreateAsync as (data: unknown) => Promise<TResult>,
    onCancel: handleCancel,
  });
}
