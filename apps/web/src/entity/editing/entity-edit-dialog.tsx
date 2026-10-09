import { Suspense, type ReactNode } from "react";

import { EntityModelBoundary } from "~/entity/entity-model";
import { browserOnlyLazy } from "~/lib/browser-only-lazy";

import type { EntityEditDialogContent as EntityEditDialogContentComponent } from "./entity-edit-dialog-content";
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
  /** Optional source evidence shown beside the existing editor fields. */
  evidence?: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  request: EntityEditDialogRequest<E>;
  onSuccess?: (result: EntityEditResultFor<E>) => void;
  /** A local command adapter for a surface whose remote transport is unavailable. */
  mutationPort?: EntityMutationPort;
}

// Interaction-only: the editor graph (react-hook-form, react-dropzone, the
// field registries) loads when a surface first opens a dialog.
// SAFETY: the loader resolves to `EntityEditDialogContent` itself;
// `browserOnlyLazy` only erases its generic signature.
const EntityEditDialogContent = browserOnlyLazy<
  EntityEditDialogProps<EditableEntity>
>(
  import.meta.env.SSR
    ? null
    : () =>
        import("./entity-edit-dialog-content").then((module) => ({
          default: module.EntityEditDialogContent,
        })),
) as typeof EntityEditDialogContentComponent;

/**
 * The typed shell every surface imports statically; the editor itself loads
 * behind the interaction boundary above.
 */
export function EntityEditDialog<E extends EditableEntity>(
  props: EntityEditDialogProps<E>,
) {
  if (!props.open) return null;

  return (
    <Suspense fallback={null}>
      <EntityModelBoundary entities={[props.request.entity]}>
        <EntityEditDialogContent {...props} />
      </EntityModelBoundary>
    </Suspense>
  );
}
