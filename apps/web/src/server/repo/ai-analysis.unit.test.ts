import { detectedInventoryAiResultSchema } from "@cubby/schemas/ai";
import { describe, expect, it } from "vitest";
import { parseStoredAiAnalysis } from "./ai-analysis";

describe("parseStoredAiAnalysis", () => {
  // The point of the wrapper is that a corrupt/partial cached AI row is
  // rejected rather than silently trusted — guard that it actually validates.
  it("rejects malformed cached JSON", () => {
    expect(() =>
      parseStoredAiAnalysis(detectedInventoryAiResultSchema, {
        summary: "Missing item fields.",
        items: [{ name: "blue tarp" }],
      }),
    ).toThrow();
  });
});
