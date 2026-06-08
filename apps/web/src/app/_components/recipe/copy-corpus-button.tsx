import type { Amount } from "@cubby/schemas/codec";
import type { RecipeOut } from "@cubby/schemas/recipe";
import { CopyDebugButton } from "./copy-debug-button";
import { buildParseReport, buildRecipeParseReport } from "./parse-report";

/** Copy one ingredient's raw line + cubby's parse (for an ingredient-parser session). */
export function CopyCorpusButton(props: {
  rawLine: string;
  name: string;
  amounts: Amount[];
  modifier?: string | null;
}) {
  return (
    <CopyDebugButton
      getText={() => buildParseReport(props)}
      label="copy parse"
      toastLabel="Copied raw line + parse"
      title="Copy the raw line + cubby's parse (for an ingredient-parser session)"
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
