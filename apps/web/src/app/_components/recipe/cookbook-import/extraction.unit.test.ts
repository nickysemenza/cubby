import { describe, expect, it } from "vitest";

import {
  extractionProgressSchema,
  extractionReportSchema,
  failureMessage,
} from "./extraction";

const usage = {
  input_tokens: 12,
  output_tokens: 4,
  cache_creation_input_tokens: 3,
  cache_read_input_tokens: 7,
};
const recipe = {
  meta: { title: "Roast carrots" },
  sections: [],
  image: {
    path: "images/carrots.jpg",
    mime: "image/jpeg",
    alt: "Roast carrots",
  },
};
const primary = {
  message: "Malformed tool arguments",
  usage,
  truncated: true,
  attempts: [
    { attempt: 0, message: "Malformed tool arguments", usage, truncated: true },
  ],
};

describe("EPUB extraction boundary", () => {
  it("retains archive images and failed-attempt usage in the ordered report", () => {
    const report = extractionReportSchema.parse({
      recipes: [recipe],
      chunks: [
        {
          index: 1,
          doc_path: "chapter.xhtml",
          tier: "fallback",
          recipes: [{ title: "Roast carrots", sections: [] }],
          usage,
          tier_usage: usage,
          cached: false,
          truncated: false,
          primary_failure: primary,
        },
      ],
      failures: [
        {
          index: 0,
          doc_path: "intro.xhtml",
          primary,
          fallback: { ...primary, message: "No tool output" },
        },
      ],
      usage,
      primary_usage: usage,
      fallback_usage: usage,
      chunks_cached: 0,
      truncations: [{ index: 0, doc_path: "intro.xhtml", tier: "primary" }],
    });
    expect(report.recipes[0]?.image).toEqual({ kind: "epub", ...recipe.image });
    expect(report.chunks[0]?.primary_failure?.attempts[0]?.usage).toEqual(
      usage,
    );
    expect(report.truncations).toHaveLength(1);
    expect(failureMessage(report.failures[0]!)).toBe(
      "Primary: Malformed tool arguments; fallback: No tool output",
    );
  });

  it("uses the same recipe normalization for previews and final results", () => {
    const progress = extractionProgressSchema.parse({
      done: 1,
      total: 2,
      cached: 0,
      failed: 0,
      preview: [recipe],
    });
    expect(progress.preview?.[0]?.image).toEqual({
      kind: "epub",
      ...recipe.image,
    });
  });

  it("rejects legacy aggregate-only reports instead of hiding missing diagnostics", () => {
    expect(
      extractionReportSchema.safeParse({ recipes: [], skipped: 2 }).success,
    ).toBe(false);
  });
});
