import { testEntityId, testShortcode } from "@cubby/schemas/testing";
import { describe, expect, it } from "vitest";

import { Database } from "~/server/db";

import {
  type IngredientMergeAiPort,
  suggestIngredientMerge,
  suggestIngredientMergeBatch,
} from "./ingredient-merge";
import type {
  MergeShortlistEntry,
  MergeShortlistPort,
} from "./merge-shortlist";

const db = new Database(() => {
  throw new Error(
    "ingredient-merge unit ports do not resolve a database runtime",
  );
});

const sourceId = testEntityId("ingredient", "source");
const source = { id: sourceId, name: "scallion" };

const candidate = (id: string, name: string): MergeShortlistEntry => ({
  id: testEntityId("ingredient", id),
  shortcode: testShortcode("ingredient", id),
  name,
  productCount: 2,
});

function shortlistPortOf(entries: MergeShortlistEntry[]): MergeShortlistPort {
  return {
    lexical: async () => entries,
    semantic: async () => [],
  };
}

describe("suggestIngredientMerge", () => {
  const green = candidate("green-onion", "green onion");
  const cilantro = candidate("cilantro", "cilantro");
  const shortlistPort = shortlistPortOf([green, cilantro]);

  it("calls the selector exactly once", async () => {
    let calls = 0;
    const ai: IngredientMergeAiPort = {
      select: async (_spec, args) => {
        calls += 1;
        return {
          selected: args.candidates[0] ?? null,
          confidence: "high",
          probability: 0.99,
          reasoning: "synonym",
        };
      },
    };

    const result = await suggestIngredientMerge(db, source, ai, shortlistPort);

    expect(calls).toBe(1);
    expect(result.target).toEqual({
      id: green.id,
      shortcode: green.shortcode,
      name: green.name,
    });
  });

  it("resolves an off-shortlist id to target: null while keeping the model's reasoning", async () => {
    const ai: IngredientMergeAiPort = {
      select: async () => ({
        selected: null,
        confidence: "low",
        probability: 0.1,
        reasoning: "hallucinated an id",
      }),
    };

    await expect(
      suggestIngredientMerge(db, source, ai, shortlistPort),
    ).resolves.toEqual({
      target: null,
      confidence: "low",
      reasoning: "hallucinated an id",
    });
  });

  it("shows the selector a rendered shortlist that contains every candidate id", async () => {
    let renderedLines: string[] = [];
    const ai: IngredientMergeAiPort = {
      select: async (spec, args) => {
        renderedLines = args.candidates.map((c) => spec.renderLine(c));
        return {
          selected: null,
          confidence: "low",
          probability: 0.1,
          reasoning: "n/a",
        };
      },
    };

    await suggestIngredientMerge(db, source, ai, shortlistPort);

    expect(renderedLines.some((line) => line.includes(green.id))).toBe(true);
    expect(renderedLines.some((line) => line.includes(cilantro.id))).toBe(true);
  });

  it("never calls the selector when the shortlist is empty", async () => {
    let calls = 0;
    const ai: IngredientMergeAiPort = {
      select: async () => {
        calls += 1;
        return {
          selected: null,
          confidence: "low",
          probability: 0.1,
          reasoning: "n/a",
        };
      },
    };

    await expect(
      suggestIngredientMerge(db, source, ai, shortlistPortOf([])),
    ).resolves.toEqual({
      target: null,
      confidence: "low",
      reasoning: "No duplicate found.",
    });
    expect(calls).toBe(0);
  });
});

describe("suggestIngredientMergeBatch", () => {
  it("caps the batch at 20 sources", async () => {
    const sources = Array.from({ length: 25 }, (_, i) => {
      const seed = `batch-${i}`;
      return {
        id: testEntityId("ingredient", seed),
        shortcode: testShortcode("ingredient", seed),
        name: `ingredient ${seed}`,
      };
    });

    const results = await suggestIngredientMergeBatch(db, sources);

    expect(results).toHaveLength(20);
  });

  it("degrades a rejecting item to a null target with a 'Lookup failed.' reasoning", async () => {
    // `suggestIngredientMergeBatch` takes no ports param — it always calls
    // the real `suggestIngredientMerge` with production ports, so the batch's
    // own db (the throwing-resolver double above) is the rejection: the
    // lexical shortlist leg tries to touch the database and fails, which is
    // exactly the "infrastructure failure" case the degrade path exists for.
    const badSource = {
      id: testEntityId("ingredient", "bad"),
      shortcode: testShortcode("ingredient", "bad"),
      name: "coriander",
    };

    const results = await suggestIngredientMergeBatch(db, [badSource]);

    expect(results).toEqual([
      {
        source: badSource,
        target: null,
        confidence: "low",
        reasoning: "Lookup failed.",
      },
    ]);
  });
});
