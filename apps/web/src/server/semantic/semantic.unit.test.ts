import { describe, expect, it } from "vitest";

import { shouldUseSemanticComboboxFallback } from "./combobox-fallback";
import { embeddingTextHash } from "./hash";
import { SEMANTIC_SEARCH_EVALS } from "./search-evals";
import {
  buildExpenseEmbeddingText,
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

  it("keeps identifiers out while retaining product-specific notes", () => {
    const text = buildProductEmbeddingText({
      name: "Reference Book",
      gtins: ["09780306406157"],
      notes: "Fits the radiant manifold in the basement",
    });

    expect(text).not.toContain("09780306406157");
    expect(text).toContain("radiant manifold");
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

  it("includes the receipt role in expense embedding text", () => {
    const text = buildExpenseEmbeddingText({
      name: "Sales tax",
      lineKind: "tax",
      costType: "materials",
      trade: "other",
      projectName: "Workshop",
      vendorName: "Tool Store",
      orderId: "ORDER-1",
    });

    expect(text).toContain("expense: Sales tax");
    expect(text).toContain("line kind: tax");
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

describe("semantic search evaluations", () => {
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
