import type { Entity } from "@cubby/schemas/entity";
import type { ReactNode } from "react";
import { useEntityCreateMode } from "~/app/_components/hooks/useEntityMode";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { entities } from "~/entities/entities";

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

export function EntityCreateWrapper<TData, TResult extends { id: string }>({
  entity,
  mutationOptions,
  children,
}: EntityCreateWrapperProps<TResult>) {
  const { error, isPending, handleCreate, handleCreateAsync, handleCancel } =
    useEntityCreateMode<TData, TResult>(entity, mutationOptions);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Create New {entities[entity].label}</CardTitle>
      </CardHeader>
      <CardContent>
        {children({
          isPending,
          error,
          onCreate: handleCreate as (data: unknown) => void,
          onCreateAsync: handleCreateAsync as (
            data: unknown,
          ) => Promise<TResult>,
          onCancel: handleCancel,
        })}
      </CardContent>
    </Card>
  );
}
