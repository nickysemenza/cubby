import { aiSmokeInputs } from "@cubby/schemas/ai-smoke";
import { describe, expect, it } from "vitest";

import { AI_FEATURES } from "./features";
import { AI_SMOKE_CASES, smokeCatalog } from "./smoke-catalog";

describe("AI smoke catalog", () => {
  it("covers every active feature and every scenario schema", () => {
    const registered = new Set(AI_FEATURES.map((feature) => feature.feature));
    const covered = new Set(
      Object.values(AI_SMOKE_CASES).map((spec) => spec.feature.feature),
    );
    expect(covered).toEqual(registered);
    expect(Object.keys(AI_SMOKE_CASES).sort()).toEqual(
      Object.keys(aiSmokeInputs).sort(),
    );
  });

  it("publishes browser-serializable input shapes and production models", () => {
    for (const item of smokeCatalog()) {
      expect(item.model).toBe(AI_SMOKE_CASES[item.id].feature.model);
      expect(item.inputSchema).toMatchObject({
        type: "object",
        properties: expect.any(Object),
      });
      expect(JSON.parse(JSON.stringify(item.inputSchema))).toEqual(
        item.inputSchema,
      );
    }
  });
});
