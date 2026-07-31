import type { Entity } from "@cubby/schemas/entity";
import type { ReactNode } from "react";
import { useEntityCreateMode } from "~/app/_components/hooks/useEntityMode";

interface CreateModeProps<TResult> {
  isPending: boolean;
  error: string | undefined;
  onCreate: (data: unknown) => void;
  onCreateAsync: (data: unknown) => Promise<TResult>;
  onCancel: () => void;
}

interface EntityCreateWrapperProps<TResult extends { id: string }> {
  entity: Entity;
  mutationOptions: object;
  children: (props: CreateModeProps<TResult>) => ReactNode;
}

export function EntityCreateWrapper<
  TData,
  TResult extends { id: string; shortcode: string },
>({ entity, mutationOptions, children }: EntityCreateWrapperProps<TResult>) {
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
