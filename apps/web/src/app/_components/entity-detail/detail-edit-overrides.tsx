import { useNavigate } from "@tanstack/react-router";
import { type ComponentType, lazy, useEffect } from "react";

import type { DetailRecordOf, GenericDetailEntity } from "./detail-record";

/** Rendered while the hero's Edit action is open; the override owns the surface. */
export type DetailEditOverride<TRecord> = ComponentType<{
  record: TRecord;
  onClose: () => void;
}>;

/**
 * Recipe editing is a page-level workflow (`?edit=true` on the recipe route
 * swaps the whole body for `EditRecipeForm`), not a dialog.
 */
function RecipeEditRedirect({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  useEffect(() => {
    void navigate({ to: ".", search: (prev) => ({ ...prev, edit: true }) });
    onClose();
  }, [navigate, onClose]);
  return null;
}

/**
 * The entities whose Edit action does not open the generic `update:full`
 * dialog: recipe edits on its own route; image has no kernel update
 * contract. Product now opens the generic dialog too — its rich fields
 * (`unitMappings`, `labelNutrition`, external IDs) have specialized
 * renderers (`entity-primitive-fields.tsx`'s `controlRendererCoverage`).
 */
export const detailEditOverrides = {
  recipe: RecipeEditRedirect,
  image: lazy(() =>
    import("~/app/images/image-edit-dialog").then((module) => ({
      default: module.ImageEditDialog,
    })),
  ),
} satisfies {
  [E in GenericDetailEntity]?: DetailEditOverride<DetailRecordOf<E>>;
};

/** The edit override for one entity, read through the erased map. */
export const detailEditOverrideFor = (
  entity: GenericDetailEntity,
): DetailEditOverride<never> | undefined =>
  Object.hasOwn(detailEditOverrides, entity)
    ? // SAFETY: `hasOwn` proves `entity` is one of the registry's own keys.
      detailEditOverrides[entity as keyof typeof detailEditOverrides]
    : undefined;
