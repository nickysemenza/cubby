import type { Amount } from "@cubby/schemas/codec";
import type { ImportRecipe } from "@cubby/schemas/import-recipe";
import type { RecipeOut } from "@cubby/schemas/recipe-responses";
import { CopyDebugButton } from "./copy-debug-button";
import {
  buildImportRecipeParseReport,
  buildParseReport,
  buildRecipeParseReport,
} from "./parse-report";

/**
 * Copy one ingredient's raw line + cubby's parse (for an ingredient-parser
 * session). `label` defaults to "copy parse"; pass `undefined` for an icon-only
 * button (e.g. on each row of a dense table).
 */
export function CopyCorpusButton({
  label = "copy parse",
  ...props
}: {
  rawLine: string;
  name: string;
  amounts: readonly Amount[];
  modifier?: string | null;
  label?: string;
}) {
  return (
    <CopyDebugButton
      getText={() => buildParseReport(props)}
      label={label}
      toastLabel="Copied raw line + parse"
      title="Copy the raw line + cubby's parse (for an ingredient-parser session)"
    />
  );
}

/** Copy an import-preview recipe's raw lines + parse (for an ingredient-parser session). */
export function CopyImportRecipeParseButton({
  recipe,
}: {
  recipe: ImportRecipe;
}) {
  return (
    <CopyDebugButton
      getText={() => buildImportRecipeParseReport(recipe)}
      label="copy parse"
      toastLabel="Copied recipe parse"
      title="Copy this recipe's raw lines + cubby's parse (for an ingredient-parser session)"
    />
  );
}

/** Copy the whole recipe's raw lines + parse (for an ingredient-parser session). */
export function CopyRecipeParseButton({ recipe }: { recipe: RecipeOut }) {
  return (
    <CopyDebugButton
      getText={() => buildRecipeParseReport(recipe)}
      label="copy parse"
      toastLabel="Copied recipe parse"
      title="Copy the whole recipe's raw lines + parse (for an ingredient-parser session)"
    />
  );
}
