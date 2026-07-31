import { describe, expect, it } from "vitest";
import { shouldUseSemanticComboboxFallback } from "./combobox-fallback";
import { embeddingTextHash } from "./hash";
import { mergeHybridSearchResults } from "./ranking";
import { SEMANTIC_SEARCH_EVALS } from "./search-evals";
import {
  buildLocationEmbeddingText,
  buildProductEmbeddingText,
  buildTaskEmbeddingText,
  normalizeSearchText,
} from "./text";

describe("semantic search text builders", () => {
  it("includes aliases in product embedding text", () => {
    const text = buildProductEmbeddingText({
      name: "Blue plastic tarp",
      manufacturer: "generic",
      category: "storage",
      aliases: ["tarpaulin", "drop cover"],
    });

    expect(text).toContain("product: Blue plastic tarp");
    expect(text).toContain("aliases: tarpaulin, drop cover");
  });

  it("includes location context and AI description", () => {
    const text = buildLocationEmbeddingText({
      name: "tarps cloths blankets",
      type: "container",
      parentPath: "garage / shelf",
      aiDescription: "Contains folded drop cloths and a blue tarp.",
      aliases: ["paint supplies"],
    });

    expect(text).toContain("location: tarps cloths blankets");
    expect(text).toContain("path: garage / shelf");
    expect(text).toContain("ai description: Contains folded drop cloths");
  });

  it("includes the subject product in task embedding text", () => {
    const text = buildTaskEmbeddingText({
      name: "Replace filter",
      status: "not_started",
      trade: "mechanical",
      projectName: "Home routines",
      subjectProductName: "Basement furnace",
    });

    expect(text).toContain("task: Replace filter");
    expect(text).toContain("product: Basement furnace");
  });
});

describe("semantic hash", () => {
  it("is stable for equivalent normalized text", async () => {
    const a = await embeddingTextHash({
      entityType: "product",
      provider: "openai",
      model: "text-embedding-3-small",
      dimensions: 1536,
      text: normalizeSearchText(" Blue   Tarp "),
    });
    const b = await embeddingTextHash({
      entityType: "product",
      provider: "openai",
      model: "text-embedding-3-small",
      dimensions: 1536,
      text: normalizeSearchText("blue tarp"),
    });

    expect(a).toBe(b);
  });

  it("changes when provider changes", async () => {
    const base = {
      entityType: "product",
      model: "text-embedding-3-small",
      dimensions: 1536,
      text: "blue tarp",
    };
    const openai = await embeddingTextHash({ ...base, provider: "openai" });
    const other = await embeddingTextHash({ ...base, provider: "workers-ai" });

    expect(openai).not.toBe(other);
  });
});

describe("hybrid ranking", () => {
  const createdAt = new Date("2026-06-28T00:00:00Z");
  const product = (id: string, name: string) => ({
    id,
    shortcode: `PRD-${id.toUpperCase()}`,
    entityType: "product" as const,
    name,
    subtitle: "generic",
    typeHint: "supplies",
    imageUrl: null,
    createdAt,
    price: null,
    stockCount: 1,
  });

  it("keeps exact lexical matches authoritative over semantic matches", () => {
    const exact = product("p1", "blue tarp");
    const semantic = product("p2", "plastic sheet");

    const [first] = mergeHybridSearchResults(
      "blue tarp",
      [exact],
      [{ item: semantic, similarity: 0.99 }],
      5,
    );

    expect(first?.id).toBe("p1");
    expect(first?.matchKind).toBe("exact");
  });

  it("ranks strong semantic household matches above weak lexical noise", () => {
    const [first] = mergeHybridSearchResults(
      "plastic tarp",
      [product("p1", "plastic storage bin")],
      [{ item: product("p2", "blue plastic tarp"), similarity: 0.95 }],
      5,
    );

    expect(first?.name).toBe("blue plastic tarp");
    expect(first?.matchKind).toBe("semantic");
    expect(first?.matchTerms).toEqual(["plastic", "tarp"]);
    expect(first?.matchReason).toContain("visible term plastic, tarp");
  });

  it("explains visible term relationships for semantic typo matches", () => {
    const [first] = mergeHybridSearchResults(
      "tarpulin",
      [],
      [{ item: product("p1", "blue plastic tarp"), similarity: 0.9 }],
      5,
    );

    expect(first?.matchKind).toBe("semantic");
    expect(first?.matchTerms).toContain("tarpulin ~ tarp");
    expect(first?.matchReason).toContain("tarpulin ~ tarp");
  });

  it("includes the planned semantic eval examples", () => {
    expect(SEMANTIC_SEARCH_EVALS.map((fixture) => fixture.query)).toEqual(
      expect.arrayContaining([
        "plastic tarp",
        "drop cloth",
        "where are tarps",
        "packout",
        "parchment",
        "tarpaulin",
        "wet dry vac",
      ]),
    );
  });
});

describe("combobox semantic fallback", () => {
  it("stays disabled for short queries, structured filters, or healthy lexical results", () => {
    expect(
      shouldUseSemanticComboboxFallback({
        lexicalCount: 0,
        query: "eg",
        hasStructuredFilters: false,
      }),
    ).toBe(false);
    expect(
      shouldUseSemanticComboboxFallback({
        lexicalCount: 0,
        query: "eggs",
        hasStructuredFilters: true,
      }),
    ).toBe(false);
    expect(
      shouldUseSemanticComboboxFallback({
        lexicalCount: 3,
        query: "drop cloth",
        hasStructuredFilters: false,
      }),
    ).toBe(false);
  });

  it("enables semantic fallback only when lexical results are weak or empty", () => {
    expect(
      shouldUseSemanticComboboxFallback({
        lexicalCount: 2,
        query: "drop cloth",
        hasStructuredFilters: false,
      }),
    ).toBe(true);
  });
});
