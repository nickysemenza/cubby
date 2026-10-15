import { useNavigate } from "@tanstack/react-router";
import { type ComponentType, useEffect } from "react";

import { entityDetailParams } from "~/entity/entities";
import { featureRegistry } from "~/entity/feature-registry";

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
export function RecipeEditRedirect({
  record,
  onClose,
}: {
  record: DetailRecordOf<"recipe">;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  useEffect(() => {
    void navigate({
      to: "/recipes/$shortcode",
      params: entityDetailParams(record.id),
      search: { edit: true },
    });
    onClose();
  }, [navigate, onClose, record.id]);
  return null;
}

/**
 * The entities whose Edit action does not open the generic `update:full`
 * dialog: recipe edits on its own route; image and cookbook have no create
 * contract, so they edit through their own operation. Product now opens the generic dialog too — its rich fields
 * (`unitMappings`, `labelNutrition`, external IDs) have specialized
 * renderers (`entity-primitive-fields.tsx`'s `controlRendererCoverage`).
 * `features/registry.tsx` fills it.
 */
export type DetailEditOverrideTable = {
  [E in GenericDetailEntity]?: DetailEditOverride<DetailRecordOf<E>>;
};

/** The edit override for one entity, read through the erased map. */
export const detailEditOverrideFor = (
  entity: GenericDetailEntity,
): DetailEditOverride<never> | undefined => {
  const detailEditOverrides = featureRegistry().detailEditOverrides;
  if (!Object.hasOwn(detailEditOverrides, entity)) return undefined;
  // SAFETY: `hasOwn` proves `entity` is one of the registry's own keys; the
  // erased override renders only with this same entity's record.
  return detailEditOverrides[entity] as DetailEditOverride<never> | undefined;
};
