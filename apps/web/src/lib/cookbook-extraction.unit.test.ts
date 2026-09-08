import type { WCookbookChunk } from "@cubby/recipebridge";
import { expect, it } from "vitest";

import { extractCookbook } from "~/app/_components/recipe/cookbook-import/extraction";

const chunk: WCookbookChunk = {
  doc_path: "soup.xhtml",
  text: "Soup\n1 cup water\nBring to a boil.",
  links: [],
  images: [],
};

const response = (ingredient: string) => ({
  input: {
    recipes: [
      {
        title: "Soup",
        sections: [
          { ingredients: [ingredient], instructions: ["Bring to a boil."] },
        ],
      },
    ],
  },
  usage: {
    input_tokens: 10,
    output_tokens: 5,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  },
  truncated: false,
});

it("validates real WASM progress and reports after correcting an invented measurement", async () => {
  let calls = 0;
  const previews: string[] = [];
  const diagnostics: string[] = [];
  const report = await extractCookbook({
    chunks: [chunk],
    source: "example.epub",
    concurrency: 1,
    callChunk: async (request) => {
      expect(request.toolSchema).toHaveProperty("properties");
      expect(request.toolName).not.toBe("");
      return response(++calls === 1 ? "2 cups water" : "1 cup water");
    },
    onProgress: (progress) => {
      for (const recipe of progress.preview ?? []) {
        previews.push(
          ...recipe.sections.flatMap((section) => section.ingredients),
        );
      }
    },
    onDiagnostic: (message) => diagnostics.push(message),
  });

  expect(calls).toBe(2);
  expect(diagnostics).toEqual([]);
  expect(previews).toContain("1 cup water");
  expect(previews).not.toContain("2 cups water");
  expect(report).toMatchObject({
    failures: [],
    recipes: [
      { meta: { title: "Soup" }, sections: [{ ingredients: ["1 cup water"] }] },
    ],
    chunks: [
      {
        doc_path: "soup.xhtml",
        recipes: [
          { title: "Soup", sections: [{ ingredients: ["1 cup water"] }] },
        ],
      },
    ],
    usage: { input_tokens: 20, output_tokens: 10 },
  });
});

it("excludes unsupported measurements after both extraction tiers fail", async () => {
  const tiers: boolean[] = [];
  const report = await extractCookbook({
    chunks: [chunk],
    source: "example.epub",
    concurrency: 1,
    callChunk: async (request) => {
      tiers.push(request.escalate ?? false);
      return response("2 cups water");
    },
    onProgress: () => {},
    onDiagnostic: (message) => {
      throw new Error(message);
    },
  });

  expect(tiers).toEqual([false, false, true, true]);
  expect(report).toMatchObject({
    recipes: [],
    chunks: [],
    failures: [
      {
        doc_path: "soup.xhtml",
        primary: {
          message: expect.stringContaining("source fidelity violation"),
        },
        fallback: {
          message: expect.stringContaining("source fidelity violation"),
        },
      },
    ],
    usage: { input_tokens: 40, output_tokens: 20 },
  });
});

it("retains validated recipes and failure accounting when another Chunk is wrong", async () => {
  let calls = 0;
  const report = await extractCookbook({
    chunks: [chunk, { ...chunk, doc_path: "other.xhtml" }],
    source: "example.epub",
    concurrency: 1,
    callChunk: async () =>
      response(++calls === 1 ? "1 cup water" : "2 cups water"),
    onProgress: () => {},
    onDiagnostic: (message) => {
      throw new Error(message);
    },
  });
  expect(report.recipes).toHaveLength(1);
  expect(report.recipes[0]?.sections[0]?.ingredients).toEqual(["1 cup water"]);
  expect(report.failures).toHaveLength(1);
  expect(report.failures[0]?.doc_path).toBe("other.xhtml");
  expect(report.usage.input_tokens).toBe(50);
});
