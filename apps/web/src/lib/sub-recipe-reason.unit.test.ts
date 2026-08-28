import type { SubRecipeBlockReason } from "@cubby/schemas/availability";
import { subRecipeBlockReason } from "@cubby/schemas/availability";
import { describe, expect, it } from "vitest";

import { blockReasonText } from "./sub-recipe-reason";

describe("blockReasonText", () => {
  it("names the fix, not just the fact, for every reason", () => {
    // These strings are what the shopping list and the prep sheet both show,
    // so each has to read as something the cook can go and correct.
    expect(blockReasonText("missingYield")).toBe(
      "needs a yield before it can be scaled",
    );
    expect(blockReasonText("noAmount")).toBe("is used without an amount");
    expect(blockReasonText("unscalable")).toBe(
      "is measured in units that don't convert to its yield",
    );
    expect(blockReasonText("cycle")).toBe(
      "refers back to a recipe that contains it",
    );
    expect(blockReasonText("unknownRecipe")).toBe("has been deleted");
  });

  it("covers every reason the engine can emit", () => {
    // The match is `.exhaustive()`, so a new Rust variant is a *compile* error
    // here — but only once the zod enum grows too. This pins the two together,
    // so adding a variant to one without the other fails loudly.
    for (const reason of subRecipeBlockReason.options) {
      expect(blockReasonText(reason as SubRecipeBlockReason)).toMatch(/\S/);
    }
  });
});
