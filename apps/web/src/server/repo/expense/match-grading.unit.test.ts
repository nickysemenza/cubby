import { describe, expect, it } from "vitest";
import {
  classifyMatchRatio,
  countTokenOverlap,
  tokenizeMatchLabel,
} from "./match-grading";

describe("expense match grading", () => {
  it("normalizes labels without treating stopwords or one-character noise as overlap", () => {
    expect([...tokenizeMatchLabel("The Milwaukee Packout, x!")]).toEqual([
      "milwaukee",
      "packout",
    ]);
    expect(
      countTokenOverlap(
        tokenizeMatchLabel("Milwaukee PACKOUT Rolling Tool Box"),
        tokenizeMatchLabel("milwaukee packout rolling toolbox"),
      ),
    ).toBe(3);
  });

  it("keeps a rounded one-cent amount delta exact", () => {
    expect(classifyMatchRatio(0.010000000000000002, 1.333, 0.08625)).toBe(
      "exact",
    );
  });

  it("labels relative tax bands but leaves additive residuals and zero amounts as other", () => {
    expect(classifyMatchRatio(8.63, 1.0863, 0.08625)).toBe("plus_tax");
    expect(classifyMatchRatio(-7.94, 0.9206, 0.08625)).toBe("pre_tax");
    expect(classifyMatchRatio(9.99, 1.0999, 0.08625)).toBe("other");
    expect(classifyMatchRatio(null, null, 0.08625)).toBe("other");
  });
});
