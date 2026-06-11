/**
 * Deterministic Notion-page → `CompactRecipe` mapping (no LLM, no DB).
 *
 * Canonical format: a `## heading` starts a section; within a section, bulleted
 * list items are ingredients and numbered list items are steps. Prose before the
 * first heading (and any quote/callout) becomes the headnote (`description` →
 * `notes`). Image blocks are ignored in v1. Empty sections are pruned. The same
 * blocks always yield the same recipe, which is what makes re-import stable.
 */

import type { CompactRecipe } from "@cubby/schemas/codec";
import type { CookbookRecipe } from "@cubby/schemas/cookbook";
import { wasm } from "~/lib/wasm";
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

export function notionPageToCompact(
  row: NotionRecipeRow,
  rawBlocks: NotionBlock[],
): CompactRecipe {
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

  // Yield column ("12 churros", "serves 4") → structured, via the same WASM
  // parser the scraper/cookbook paths use. An explicit Servings column overrides.
  const parsedYield = row.yieldText
    ? wasm.parse_yield(row.yieldText)
    : undefined;

  return {
    name: row.name,
    sections: sections.map((s) => ({
      name: s.name,
      ingredients: s.ingredients,
      instructions: s.instructions,
    })),
    recipe_yield: parsedYield?.recipe_yield ?? undefined,
    servings: row.servings ?? parsedYield?.servings ?? undefined,
    description,
  };
}

/**
 * Adapt a mapped Notion page to the `CookbookRecipe` shape the shared import
 * card renders — so the Notion and EPUB previews use the exact same component
 * (ingredient-match table, headnote, rich-text steps). The raw yield string is
 * kept for display; notes are already folded into `description`; no references.
 */
export function notionCompactToCookbookRecipe(
  compact: CompactRecipe,
  yieldText: string | null,
): CookbookRecipe {
  return {
    meta: {
      title: compact.name,
      recipe_yield: yieldText ?? undefined,
      description: compact.description,
    },
    sections: compact.sections.map((s) => ({
      name: s.name ?? undefined,
      ingredients: s.ingredients,
      instructions: s.instructions,
    })),
    references: [],
  };
}

export type NotionLintStatus = "ok" | "needs-formatting";

/**
 * Lint a mapped recipe for importability: it needs at least one ingredient
 * (a bullet) and one step (a numbered item) somewhere. Returns human-readable
 * reasons so the preview can tell the user what to fix in Notion.
 */
export function lintNotionCompact(compact: CompactRecipe): {
  status: NotionLintStatus;
  reasons: string[];
} {
  const reasons: string[] = [];
  const hasIngredients = compact.sections.some((s) => s.ingredients.length > 0);
  const hasInstructions = compact.sections.some(
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
