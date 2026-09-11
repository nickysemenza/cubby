import {
  parseShortcodeFor,
  type RecipeId,
  type RecipeShortcode,
} from "@cubby/schemas/identifiers";

import { getErrorMessage } from "~/lib/error-utils";
import type { UpsertedRecipe } from "~/server/repo/recipe/crud";

type CookbookImportEvent =
  | {
      readonly sourceRecipeId: string;
      readonly ok: true;
      readonly id: RecipeShortcode;
      readonly hasImage: boolean;
    }
  | {
      readonly sourceRecipeId: string;
      readonly ok: false;
      readonly error: string;
    };
export type CookbookImportProjection = {
  readonly recipeId: RecipeId;
  readonly event: CookbookImportEvent;
};

/** A committed recipe remains part of final batch effects when presentation
 * data cannot be read. */
export const projectCookbookImportEvent = async (
  sourceRecipeId: string,
  imported: UpsertedRecipe,
  hasImage: Promise<boolean>,
): Promise<CookbookImportProjection> => {
  // The read starts before projection is called. Settle it even if shortcode
  // validation fails, so no rejected read outlives the committed item.
  const [image] = await Promise.allSettled([hasImage]);
  try {
    const id = parseShortcodeFor("recipe", imported.shortcode);
    if (image.status === "rejected") throw image.reason;
    return {
      recipeId: imported.id,
      event: {
        sourceRecipeId,
        ok: true,
        id,
        hasImage: image.value,
      },
    };
  } catch (error) {
    return {
      recipeId: imported.id,
      event: { sourceRecipeId, ok: false, error: getErrorMessage(error) },
    };
  }
};

type NotionImportEvent =
  | {
      readonly pageId: string;
      readonly ok: true;
      readonly id: RecipeShortcode;
      readonly status: "created" | "updated";
    }
  | { readonly pageId: string; readonly ok: false; readonly error: string };
export type NotionImportProjection = {
  readonly recipeId: RecipeId;
  readonly event: NotionImportEvent;
};

export const projectNotionImportEvent = (
  pageId: string,
  existing: boolean,
  imported: UpsertedRecipe,
): NotionImportProjection => {
  try {
    return {
      recipeId: imported.id,
      event: {
        pageId,
        ok: true,
        id: parseShortcodeFor("recipe", imported.shortcode),
        status: existing ? "updated" : "created",
      },
    };
  } catch (error) {
    return {
      recipeId: imported.id,
      event: { pageId, ok: false, error: getErrorMessage(error) },
    };
  }
};
