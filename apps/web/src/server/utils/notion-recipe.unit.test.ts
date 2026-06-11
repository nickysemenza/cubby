import { describe, expect, it } from "vitest";
import type { NotionBlock, NotionRecipeRow } from "~/server/clients/notion";
import { lintImportRecipe, notionPageToImportRecipe } from "./notion-recipe";

const row = (over: Partial<NotionRecipeRow> = {}): NotionRecipeRow => ({
  id: "page-1",
  name: "Churros with Strawberry Dust",
  source: null,
  // null so the mapping never calls WASM parse_yield in this unit test.
  yieldText: null,
  servings: null,
  tags: [],
  notionUrl: "https://www.notion.so/page1",
  ...over,
});

const h = (level: 1 | 2 | 3, text: string): NotionBlock => ({
  type: `heading_${level}`,
  text,
});
const bullet = (text: string): NotionBlock => ({
  type: "bulleted_list_item",
  text,
});
const step = (text: string): NotionBlock => ({
  type: "numbered_list_item",
  text,
});

// The reformatted churros page: a leading H1 (title echo) + image, then dough /
// frying / strawberry-dust sections.
const churrosBlocks: NotionBlock[] = [
  h(1, "churros with strawberry dust"),
  { type: "image", imageUrl: "https://signed.example/expiring.png" },
  h(2, "dough"),
  bullet("250 g water"),
  bullet("50 g butter"),
  step("Bring to a simmer."),
  step("Add the flour."),
  h(2, "frying"),
  bullet("vegetable oil, for frying"),
  step("Pipe into 375°F oil."),
  h(2, "strawberry dust"),
  bullet("freeze-dried strawberries"),
  step("Grind and sift over the churros."),
];

describe("notionPageToImportRecipe", () => {
  it("maps headings→sections, bullets→ingredients, numbers→steps", () => {
    const compact = notionPageToImportRecipe(row(), churrosBlocks);

    expect(compact.meta.title).toBe("Churros with Strawberry Dust");
    // The leading H1 holds only the image → pruned as an empty section.
    expect(compact.sections.map((s) => s.name)).toEqual([
      "dough",
      "frying",
      "strawberry dust",
    ]);
    expect(compact.sections[0]).toEqual({
      name: "dough",
      ingredients: ["250 g water", "50 g butter"],
      instructions: ["Bring to a simmer.", "Add the flour."],
    });
    expect(compact.sections[1].ingredients).toEqual([
      "vegetable oil, for frying",
    ]);
  });

  it("is deterministic — same blocks yield identical output", () => {
    const a = notionPageToImportRecipe(row(), churrosBlocks);
    const b = notionPageToImportRecipe(row(), churrosBlocks);
    expect(a).toEqual(b);
  });

  it("collects headnote, trailing tips, and the source link into description", () => {
    const blocks: NotionBlock[] = [
      { type: "paragraph", text: "A classic." },
      h(2, "dough"),
      bullet("flour"),
      step("mix"),
      { type: "quote", text: "Tip: rest the dough." },
    ];
    const compact = notionPageToImportRecipe(
      row({ source: "https://example.com/churros" }),
      blocks,
    );
    expect(compact.meta.description).toBe(
      "A classic.\n\nTip: rest the dough.\n\nSource: https://example.com/churros",
    );
  });

  it("ignores image blocks (v1)", () => {
    const compact = notionPageToImportRecipe(row(), churrosBlocks);
    expect(JSON.stringify(compact)).not.toContain("expiring.png");
  });
});

describe("lintImportRecipe", () => {
  it("passes a recipe with ingredients and steps", () => {
    const compact = notionPageToImportRecipe(row(), churrosBlocks);
    expect(lintImportRecipe(compact).status).toBe("ok");
  });

  it("flags a recipe with no steps", () => {
    const compact = notionPageToImportRecipe(row(), [
      h(2, "salsa"),
      bullet("tomatillos"),
    ]);
    const { status, reasons } = lintImportRecipe(compact);
    expect(status).toBe("needs-formatting");
    expect(reasons.join(" ")).toMatch(/no steps/i);
  });

  it("flags a recipe with no ingredients", () => {
    const compact = notionPageToImportRecipe(row(), [
      h(2, "method"),
      step("do a thing"),
    ]);
    const { status, reasons } = lintImportRecipe(compact);
    expect(status).toBe("needs-formatting");
    expect(reasons.join(" ")).toMatch(/no ingredients/i);
  });
});
