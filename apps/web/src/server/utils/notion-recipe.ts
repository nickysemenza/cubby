/**
 * Deterministic Notion-page → `ImportRecipe` mapping (no LLM, no DB).
 *
 * Canonical format: a `## heading` starts a section; within a section, bulleted
 * list items are ingredients and numbered list items are steps. Prose before the
 * first heading (and any quote/callout) becomes the headnote (`description` →
 * `notes`). Image blocks are ignored in v1. Empty sections are pruned. The same
 * blocks always yield the same recipe, which is what makes re-import stable.
 */

import type { ImportRecipe } from "@cubby/schemas/import-recipe";
import type { NotionBlock, NotionRecipeRow } from "~/server/clients/notion";

const HEADING_TYPES = new Set(["heading_1", "heading_2", "heading_3"]);

type DraftSection = {
  name: string | null;
  ingredients: string[];
  instructions: string[];
};

// `getPageContent` wraps Notion column layouts as a single `columns` block with
// children; flatten so recipe content inside columns is still seen.
function flattenColumns(blocks: NotionBlock[]): NotionBlock[] {
  const out: NotionBlock[] = [];
  for (const b of blocks) {
    if (b.type === "columns" && b.children) out.push(...b.children);
    else out.push(b);
  }
  return out;
}

export function notionPageToImportRecipe(
  row: NotionRecipeRow,
  rawBlocks: NotionBlock[],
): ImportRecipe {
  const blocks = flattenColumns(rawBlocks);

  const sections: DraftSection[] = [];
  let current: DraftSection = { name: null, ingredients: [], instructions: [] };
  const headnote: string[] = [];
  const tips: string[] = [];
  let seenHeading = false;

  // Drop sections with neither ingredients nor steps (e.g. a leading `# Title`
  // H1 that only carries the page name).
  const flushSection = () => {
    if (current.ingredients.length > 0 || current.instructions.length > 0) {
      sections.push(current);
    }
  };

  for (const block of blocks) {
    const text = block.text?.trim() ?? "";

    if (HEADING_TYPES.has(block.type)) {
      flushSection();
      current = {
        name: text.length >= 2 ? text : null,
        ingredients: [],
        instructions: [],
      };
      seenHeading = true;
      continue;
    }

    switch (block.type) {
      case "bulleted_list_item":
        if (text) current.ingredients.push(text);
        break;
      case "numbered_list_item":
        if (text) current.instructions.push(text);
        break;
      case "quote":
      case "callout":
        // Quotes/callouts are headnote before the first heading, tips after.
        if (text) (seenHeading ? tips : headnote).push(text);
        break;
      case "paragraph":
        // Only leading paragraphs are the headnote; mid-recipe prose is ignored.
        if (text && !seenHeading) headnote.push(text);
        break;
      default:
        break;
    }
  }
  flushSection();

  // Carry the original source link (the Notion `Source` column) into the notes,
  // since a Notion recipe's provenance slot is taken by the page id.
  const sourceLine = row.source ? `Source: ${row.source}` : null;
  const descriptionParts = [
    ...headnote,
    ...tips,
    ...(sourceLine ? [sourceLine] : []),
  ];
  const description =
    descriptionParts.length > 0 ? descriptionParts.join("\n\n") : undefined;

  return {
    meta: {
      title: row.name,
      description,
      // Keep the raw yield line; the import converter / signature re-parse it via
      // WASM (and a `Servings` column overrides via the top-level field below).
      recipe_yield: row.yieldText ?? undefined,
    },
    sections: sections.map((s) => ({
      name: s.name ?? undefined,
      ingredients: s.ingredients,
      instructions: s.instructions,
    })),
    references: [],
    servings: row.servings ?? undefined,
  };
}

export type NotionLintStatus = "ok" | "needs-formatting";

/**
 * Lint a mapped recipe for importability: it needs at least one ingredient
 * (a bullet) and one step (a numbered item) somewhere. Returns human-readable
 * reasons so the preview can tell the user what to fix in Notion.
 */
export function lintImportRecipe(recipe: ImportRecipe): {
  status: NotionLintStatus;
  reasons: string[];
} {
  const reasons: string[] = [];
  const hasIngredients = recipe.sections.some((s) => s.ingredients.length > 0);
  const hasInstructions = recipe.sections.some(
    (s) => s.instructions.length > 0,
  );
  if (!hasIngredients) {
    reasons.push("No ingredients found — add a bulleted list under a heading.");
  }
  if (!hasInstructions) {
    reasons.push("No steps found — add a numbered list under a heading.");
  }
  return {
    status: reasons.length === 0 ? "ok" : "needs-formatting",
    reasons,
  };
}
