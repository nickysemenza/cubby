import {
  extract_cookbook,
  type WChunkRequest,
  type WCookbookChunk,
} from "@cubby/recipebridge";
import { expect, it } from "vitest";

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
  usage: { input_tokens: 10, output_tokens: 5 },
  truncated: false,
});

it("retries an invented measurement and accepts the source-backed correction", async () => {
  let calls = 0;
  const report: unknown = await extract_cookbook(
    [chunk],
    "example.epub",
    1,
    async () => response(++calls === 1 ? "2 cups water" : "1 cup water"),
    () => {},
  );

  expect(calls).toBe(2);
  expect(report).toMatchObject({
    failures: [],
    chunks: [
      {
        doc_path: "soup.xhtml",
        recipes: [
          new Map<string, unknown>([
            ["title", "Soup"],
            [
              "sections",
              [
                {
                  ingredients: ["1 cup water"],
                  instructions: ["Bring to a boil."],
                },
              ],
            ],
          ]),
        ],
      },
    ],
    usage: { input_tokens: 20, output_tokens: 10 },
  });
});

it("excludes unsupported measurements after both extraction tiers fail", async () => {
  const tiers: boolean[] = [];
  const report: unknown = await extract_cookbook(
    [chunk],
    "example.epub",
    1,
    async (_request: WChunkRequest, fallback: boolean) => {
      tiers.push(fallback);
      return response("2 cups water");
    },
    () => {},
  );

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
