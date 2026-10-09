import { subRecipeBlockReason } from "@cubby/schemas/availability";
import { describe, expect, it } from "vitest";

import { blockReasonText } from "./sub-recipe-reason";

describe("blockReasonText", () => {
  it("covers every reason the engine can emit", () => {
    // The match is `.exhaustive()`, so a new Rust variant is a *compile* error
    // here — but only once the zod enum grows too. This pins the two together,
    // so adding a variant to one without the other fails loudly.
    for (const reason of subRecipeBlockReason.options) {
      expect(blockReasonText(reason)).toMatch(/\S/);
    }
  });
});
