import { describe, expect, it } from "vitest";

import { photoGroupSteps } from "./photo-group-steps";

describe("server photo group steps", () => {
  // Description failures block member writes, and terminal runs cannot look ready.
  it("projects image, concern, stock and run blockers while allowing legacy review", () => {
    const base = {
      state: "proposed" as const,
      runStatus: "running",
      kind: "create" as const,
      productName: "Synthetic boot 10 D",
      productMissing: false,
      imageCount: 1,
      skipCount: 0,
      concern: null,
      stockIntent: "evidence",
      inventoryMissing: false,
      descriptionBlocked: false,
    };
    expect(photoGroupSteps(base).blockedReason).toBeNull();
    expect(photoGroupSteps(base).steps[1]?.status).toBe("needs_input");
    expect(
      photoGroupSteps({ ...base, concern: "Read the label" }).steps[1],
    ).toMatchObject({ status: "needs_input", summary: "Read the label" });
    expect(
      photoGroupSteps({ ...base, descriptionBlocked: true }).blockedReason,
    ).toContain("description");
    expect(
      photoGroupSteps({ ...base, runStatus: "failed" }).blockedReason,
    ).toContain("failed");
    expect(
      photoGroupSteps({
        ...base,
        stockIntent: "receive",
        inventoryMissing: true,
      }).blockedReason,
    ).toContain("Inventory");
    expect(
      photoGroupSteps({
        ...base,
        imageCount: 0,
        skipCount: 1,
        concern: "No identity",
      }).blockedReason,
    ).toBeNull();
    expect(
      photoGroupSteps({
        ...base,
        state: "committed",
        runStatus: "completed",
      }).steps.every((step) => step.status === "done"),
    ).toBe(true);
  });
});
