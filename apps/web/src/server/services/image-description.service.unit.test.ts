import { describe, expect, it } from "vitest";

import { fetchAnalysisRendition } from "./image-description.service";

const RENDITION_URL =
  "https://images.example.com/cdn-cgi/image/width=2048,format=jpeg/a.jpg";

const respondWith = (response: Response) => async () => response;

describe("fetchAnalysisRendition", () => {
  it("reports the raw status and body snippet of a failed rendition", async () => {
    const body = `Error 9401: rendition unavailable ${"x".repeat(2_000)}`;
    const failure = () =>
      fetchAnalysisRendition(
        RENDITION_URL,
        respondWith(new Response(body, { status: 502 })),
      );

    await expect(failure()).rejects.toThrow(
      /HTTP 502.*Error 9401: rendition unavailable/,
    );
    // A snippet, not the whole error page.
    await expect(failure()).rejects.not.toThrow("x".repeat(600));
  });

  it("returns the body bytes of a successful rendition", async () => {
    const bytes = await fetchAnalysisRendition(
      RENDITION_URL,
      respondWith(new Response(new Uint8Array([1, 2, 3]), { status: 200 })),
    );
    expect([...bytes]).toEqual([1, 2, 3]);
  });
});

it("does not adopt model-invented zero nutrients or foreign image attribution", async () => {
  const { normalizeImageDescriptionResult } =
    await import("./image-description.service");
  const result = normalizeImageDescriptionResult(
    {
      description: "A package nutrition panel",
      cutoutEligibility: "ineligible",
      claims: [
        { text: "Nutrition Facts", evidenceKind: "ocr", imageId: "IMG-4K7M" },
      ],
      nutritionFacts: {
        servingGrams: 40,
        nutrients: { kcal: 120 },
        inferredZeroNutrients: ["vitamin_c"],
        inferenceEvidence: "Model guess",
      },
    },
    "IMG-2345",
  );
  expect(result.claims[0]?.imageId).toBe("IMG-2345");
  expect(result.nutritionFacts).toMatchObject({
    nutrients: { kcal: 120 },
    inferredZeroNutrients: [],
    inferenceEvidence: null,
  });
});

it.each([
  { footnote: "Not a significant source of total fat.", named: ["fat"] },
  {
    footnote: "Not a significant source of total fat, calcium, and iron.",
    named: ["fat", "calcium", "iron"],
  },
  {
    footnote: "Not a significant source of total fat and calcium.",
    named: ["fat", "calcium"],
  },
])(
  "retains named inferred zeros from the quoted footnote $footnote",
  async ({ footnote, named }) => {
    const { normalizeImageDescriptionResult } =
      await import("./image-description.service");
    const result = normalizeImageDescriptionResult(
      {
        description: "A package nutrition panel",
        cutoutEligibility: "ineligible",
        claims: [{ text: footnote, evidenceKind: "ocr" }],
        nutritionFacts: {
          servingGrams: 40,
          nutrients: { kcal: 120 },
          inferredZeroNutrients: [...named, "vitamin_c"],
          inferenceEvidence: footnote,
        },
      },
      "IMG-2345",
    );
    expect(result.nutritionFacts).toMatchObject({
      inferredZeroNutrients: named,
      inferenceEvidence: footnote,
    });
  },
);

it("keeps nutrients outside the significant-source footnote unknown", async () => {
  const { normalizeImageDescriptionResult } =
    await import("./image-description.service");
  const evidence =
    "Not a significant source of calcium. Total fat amount unreadable.";
  const result = normalizeImageDescriptionResult(
    {
      description: "A package nutrition panel",
      cutoutEligibility: "ineligible",
      claims: [{ text: evidence, evidenceKind: "ocr" }],
      nutritionFacts: {
        servingGrams: 40,
        nutrients: { kcal: 120 },
        inferredZeroNutrients: ["fat"],
        inferenceEvidence: evidence,
      },
    },
    "IMG-2345",
  );
  expect(result.nutritionFacts).toMatchObject({
    nutrients: { kcal: 120 },
    inferredZeroNutrients: [],
    inferenceEvidence: null,
  });
});
