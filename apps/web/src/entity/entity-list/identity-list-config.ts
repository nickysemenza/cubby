import type { entityFieldModels } from "@cubby/schemas/entity-fields";
import {
  type BrowserRoutedEntity,
  entityIndex,
} from "@cubby/schemas/entity-index";

import { entityFieldModel } from "~/entity/entity-model";

const DEFAULT_IDENTITY_WIDTH = "w-64";

export function identityWidthClassName(
  width: (typeof entityFieldModels)[BrowserRoutedEntity]["fields"][number]["display"]["width"],
): string {
  switch (width) {
    case "xs":
      return "w-20";
    case "sm":
      return "w-28";
    case "md":
      return "w-40";
    case "lg":
      return "w-56";
    case null:
      return DEFAULT_IDENTITY_WIDTH;
  }
}

export interface IdentityListConfig {
  titleField: string;
  canAutoEdit: boolean;
}

/**
 * Resolves the generic identity contract from the compiled field model.
 * Inline editing is deliberately narrower than title rendering: only a flat
 * generated CRUD list may write the same non-null text field that it reads.
 */
export function identityListConfig(
  entity: BrowserRoutedEntity,
  options: {
    generatedCrud: boolean;
    flatRows: boolean;
  },
): IdentityListConfig {
  const titleField = entityIndex[entity].titleField;
  const field = entityFieldModel(entity).fields.find(
    (candidate) => candidate.key === titleField,
  );
  const canAutoEdit =
    options.generatedCrud &&
    options.flatRows &&
    field?.kind === "text" &&
    field.readKey === titleField &&
    !field.nullable &&
    entityFieldModel(entity).update.some((key) => key === titleField);

  return {
    titleField,
    canAutoEdit,
  };
}
