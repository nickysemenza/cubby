import { detectedInventoryAiResultSchema } from "@cubby/schemas/ai";
import { describe, expect, it } from "vitest";
import { parseStoredAiAnalysis } from "./ai-analysis";

describe("parseStoredAiAnalysis", () => {
  it("parses cached structured inventory detections", () => {
    const parsed = parseStoredAiAnalysis(detectedInventoryAiResultSchema, {
      summary: "Tarps and drop cloths.",
      items: [
        {
          name: "blue tarp",
          manufacturer: "(unspecified)",
          estimatedQuantity: 1,
          unit: "each",
          category: "supplies",
          confidence: "medium",
          evidence: "A blue folded plastic sheet is visible.",
          isMisc: false,
        },
      ],
    });

    expect(parsed.items[0]?.name).toBe("blue tarp");
  });

  it("rejects malformed cached JSON", () => {
    expect(() =>
      parseStoredAiAnalysis(detectedInventoryAiResultSchema, {
        summary: "Missing item fields.",
        items: [{ name: "blue tarp" }],
      }),
    ).toThrow();
  });
});
