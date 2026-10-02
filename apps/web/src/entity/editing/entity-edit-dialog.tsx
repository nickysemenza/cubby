import { Suspense } from "react";

import { EntityEditDialogContent } from "./entity-edit-dialog-content";
import type {
  EntityEditIntent as TypedEntityEditIntent,
  EntityEditResultFor,
} from "./intent-types";
import type {
  EditableEntity,
  EntityEditRequest,
  EntityMutationPort,
} from "./types";

/**
 * A dialog request names its intent explicitly: the generic shell has no
 * per-entity default beyond the registry's, and a caller that means "the
 * default" spells it so the presentation lookup (`editor-presentations.tsx`)
 * is a plain key match.
 */
type DialogRequestFor<
  E extends EditableEntity,
  O extends "create" | "update",
> = Omit<EntityEditRequest<E, O>, "surface"> & {
  intent: TypedEntityEditIntent<E, O>;
};

type SupportedEntityEditDialogRequest = {
  [K in EditableEntity]:
    | DialogRequestFor<K, "create">
    | DialogRequestFor<K, "update">;
}[EditableEntity];

export type EntityEditDialogRequest<E extends EditableEntity = EditableEntity> =
  Extract<SupportedEntityEditDialogRequest, { entity: E }>;

export interface EntityEditDialogProps<E extends EditableEntity> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  request: EntityEditDialogRequest<E>;
  onSuccess?: (result: EntityEditResultFor<E>) => void;
  /** A local command adapter for a surface whose remote transport is unavailable. */
  mutationPort?: EntityMutationPort;
}

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
      <EntityEditDialogContent {...props} />
    </Suspense>
  );
}
