import { lazy, Suspense } from "react";
import type { EntityEditResultFor } from "./intent-types";
import type { EditableEntity, EntityEditRequest } from "./types";

type SupportedEntityEditDialogRequest =
  | (Omit<EntityEditRequest<"person", "create", "capture">, "surface"> & {
      intent: "capture";
    })
  | (Omit<EntityEditRequest<"person", "update", "full">, "surface"> & {
      intent: "full";
    })
  | (Omit<EntityEditRequest<"meal", "create", "capture">, "surface"> & {
      intent: "capture";
    })
  | (Omit<EntityEditRequest<"task", "create", "capture">, "surface"> & {
      intent: "capture";
    })
  | (Omit<EntityEditRequest<"expense", "create", "capture">, "surface"> & {
      intent: "capture";
    })
  | (Omit<EntityEditRequest<"project", "create", "capture">, "surface"> & {
      intent: "capture";
    })
  | (Omit<EntityEditRequest<"vendor", "create", "capture">, "surface"> & {
      intent: "capture";
    })
  | (Omit<EntityEditRequest<"purchase", "create", "capture">, "surface"> & {
      intent: "capture";
    })
  | (Omit<
      EntityEditRequest<"financialAccount", "create", "capture">,
      "surface"
    > & { intent: "capture" })
  | (Omit<
      EntityEditRequest<"financialAccount", "update", "full">,
      "surface"
    > & { intent: "full" })
  | (Omit<
      EntityEditRequest<"financialTransaction", "create", "capture">,
      "surface"
    > & { intent: "capture" })
  | (Omit<
      EntityEditRequest<"financialTransaction", "update", "full">,
      "surface"
    > & { intent: "full" })
  | (Omit<EntityEditRequest<"wish", "create", "full">, "surface"> & {
      intent: "full";
    })
  | (Omit<EntityEditRequest<"wish", "update", "full">, "surface"> & {
      intent: "full";
    });

export type EntityEditDialogRequest<
  E extends EditableEntity = SupportedEntityEditDialogRequest["entity"],
> = Extract<SupportedEntityEditDialogRequest, { entity: E }>;

export interface EntityEditDialogProps<E extends EditableEntity> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  request: EntityEditDialogRequest<E>;
  onSuccess?: (result: EntityEditResultFor<E>) => void;
}

const EntityEditDialogContent = lazy(() =>
  import("./entity-edit-dialog-content").then((module) => ({
    default: module.EntityEditDialogContent,
  })),
);

/**
 * Keep the semantic and field registries behind the interaction boundary.
 * Route definitions import this typed shell eagerly, but the full editor graph
 * is fetched only when a surface actually mounts a dialog.
 */
export function EntityEditDialog<E extends EditableEntity>(
  props: EntityEditDialogProps<E>,
) {
  if (!props.open) return null;

  return (
    <Suspense fallback={null}>
      <EntityEditDialogContent
        {...(props as unknown as EntityEditDialogProps<EditableEntity>)}
      />
    </Suspense>
  );
}
