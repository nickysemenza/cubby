import { describe, expect, it } from "vitest";

import {
  entityDisplayImagesInput,
  entityDisplayImagesOutput,
  ID_CHUNK_SIZE,
} from "./entity-media";

describe("entity media contract", () => {
  it("bounds public ref batches and permits explicit no-image results", () => {
    const refs = Array.from({ length: ID_CHUNK_SIZE }, (_, index) => ({
      entityType: "product" as const,
      entityId: `PRD-${index}`,
    }));

    expect(entityDisplayImagesInput.safeParse({ refs }).success).toBe(true);
    expect(
      entityDisplayImagesInput.safeParse({
        refs: [...refs, { entityType: "product", entityId: "PRD-OVER" }],
      }).success,
    ).toBe(false);
    expect(
      entityDisplayImagesOutput.parse({
        "product:PRD-PICTURED": { url: "https://images.example/cover.jpg" },
        "product:PRD-EMPTY": null,
      }),
    ).toEqual({
      "product:PRD-PICTURED": { url: "https://images.example/cover.jpg" },
      "product:PRD-EMPTY": null,
    });
  });
});
