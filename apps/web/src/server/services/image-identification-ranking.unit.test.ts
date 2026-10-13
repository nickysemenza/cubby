import { productShortcode } from "@cubby/schemas/identifiers";
import { describe, expect, it, vi } from "vitest";

import { evaluateVisualProductCandidates } from "./image-identification-ranking";

const source = { content_type: "image/jpeg" as const, base64: "AQID" };
const candidates = [
  {
    productId: productShortcode.parse("PRD-4K7M"),
    name: "Synthetic blue drill",
    imageUrl: "https://example.com/blue.jpg",
  },
  {
    productId: productShortcode.parse("PRD-2345"),
    name: "Synthetic red drill",
    imageUrl: "https://example.com/red.jpg",
  },
];
const answer = (selectedIndex: number | null) => ({
  selectedIndex,
  confidence: "high" as const,
  probability: 0.9,
  ranked: [
    { index: 1, probability: 0.8 },
    { index: 0, probability: 0.1 },
  ],
});

describe("visual Product evidence", () => {
  it("does not convert none-of-these into a match even with ranked alternatives", async () => {
    const decide = vi
      .fn()
      .mockResolvedValueOnce(answer(1))
      .mockResolvedValueOnce(answer(null));
    const result = await evaluateVisualProductCandidates({
      source,
      candidates,
      decide,
      loadImage: async () => source,
    });
    expect(result.candidates).toEqual([]);
    expect(result.outcome).toBe("no_match");
    expect(decide.mock.calls[1]![0].allowNone).toBe(true);
  });

  it("compares the shortlist using the correct reference image order and retains no invented identities", async () => {
    const decide = vi
      .fn()
      .mockResolvedValueOnce(answer(1))
      .mockResolvedValueOnce({
        ...answer(0),
        ranked: [
          { index: 0, probability: 0.9 },
          { index: 1, probability: 0.08 },
        ],
      });
    const loadImage = vi.fn(async (url: string) => ({
      ...source,
      base64: url.endsWith("red.jpg") ? "BAUG" : "BwgJ",
    }));
    const result = await evaluateVisualProductCandidates({
      source,
      candidates,
      decide,
      loadImage,
    });
    expect(
      decide.mock.calls[1]![0].images.map(
        (value: typeof source) => value.base64,
      ),
    ).toEqual(["AQID", "BAUG", "BwgJ"]);
    expect(result.candidates[0]?.productId).toBe(candidates[1]!.productId);
    expect(result.candidates).toHaveLength(2);
  });

  it("does not claim a visual match for candidates without independent reference images", async () => {
    const decide = vi.fn();
    const result = await evaluateVisualProductCandidates({
      source,
      candidates: candidates.map((candidate) => ({
        ...candidate,
        imageUrl: null,
      })),
      decide,
      loadImage: async () => source,
    });
    expect(result.outcome).toBe("no_candidates");
    expect(decide).not.toHaveBeenCalled();
  });
});
