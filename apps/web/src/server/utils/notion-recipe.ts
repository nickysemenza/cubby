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

type RecipeBlockAccumulator = {
  sections: DraftSection[];
  current: DraftSection;
  headnote: string[];
  tips: string[];
  seenHeading: boolean;
};

const emptySection = (name: string | null = null): DraftSection => ({
  name,
  ingredients: [],
  instructions: [],
});

const flushSection = (draft: RecipeBlockAccumulator): void => {
  if (
    draft.current.ingredients.length > 0 ||
    draft.current.instructions.length > 0
  ) {
    draft.sections.push(draft.current);
  }
};

const consumeRecipeBlock = (
  draft: RecipeBlockAccumulator,
  block: NotionBlock,
): void => {
  const text = block.text?.trim() ?? "";
  if (HEADING_TYPES.has(block.type)) {
    flushSection(draft);
    draft.current = emptySection(text.length >= 2 ? text : null);
    draft.seenHeading = true;
    return;
  }

  switch (block.type) {
    case "bulleted_list_item":
      if (text) draft.current.ingredients.push(text);
      return;
    case "numbered_list_item":
      if (text) draft.current.instructions.push(text);
      return;
    case "quote":
    case "callout":
      if (text) (draft.seenHeading ? draft.tips : draft.headnote).push(text);
      return;
    case "paragraph":
      if (text && !draft.seenHeading) draft.headnote.push(text);
  }
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
  const draft: RecipeBlockAccumulator = {
    sections: [],
    current: emptySection(),
    headnote: [],
    tips: [],
    seenHeading: false,
  };
  for (const block of blocks) consumeRecipeBlock(draft, block);
  // Drop sections with neither ingredients nor steps (e.g. a leading `# Title`
  // H1 that only carries the page name).
  flushSection(draft);

  // Carry the original source link (the Notion `Source` column) into the notes,
  // since a Notion recipe's provenance slot is taken by the page id.
  const sourceLine = row.source ? `Source: ${row.source}` : null;
  const descriptionParts = [
    ...draft.headnote,
    ...draft.tips,
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
    sections: draft.sections.map((s) => ({
      name: s.name ?? undefined,
      ingredients: s.ingredients,
      instructions: s.instructions,
    })),
    references: [],
    servings: row.servings ?? undefined,
  };
}

type NotionLintStatus = "ok" | "needs-formatting";

type NotionLintResult = {
  status: NotionLintStatus;
  reasons: string[];
};

/**
 * Lint a mapped recipe for importability: it needs at least one ingredient
 * (a bullet) and one step (a numbered item) somewhere. Returns human-readable
 * reasons so the preview can tell the user what to fix in Notion.
 */
export function lintImportRecipe(recipe: ImportRecipe): NotionLintResult {
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
