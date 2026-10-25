import { describe, expect, it } from "vitest";

import {
  doorbellRing,
  mergeDatabaseChanges,
  type DatabaseChanges,
} from "./doorbell";

describe("record change hints", () => {
  it("validates the new wire shape and rejects oversized record sets", () => {
    expect(
      doorbellRing.parse({
        type: "ring",
        topic: "household.changed",
        changes: { imageJob: ["IPR-A3F2"], image: null },
      }).changes,
    ).toEqual({ imageJob: ["IPR-A3F2"], image: null });
    expect(
      doorbellRing.safeParse({
        type: "ring",
        topic: "household.changed",
        changes: {
          imageJob: Array.from({ length: 201 }, (_, i) => `IPR-${i}`),
        },
      }).success,
    ).toBe(false);
  });
  it("unions ids, absorbs them into null in either order, and collapses large batches", () => {
    const changes: DatabaseChanges = {};
    mergeDatabaseChanges(changes, { imageJob: ["IPR-A3F2"] });
    mergeDatabaseChanges(changes, {
      imageJob: ["IPR-A3F2", "IPR-B4G3"],
      image: null,
    });
    expect(changes.imageJob).toEqual(["IPR-A3F2", "IPR-B4G3"]);
    mergeDatabaseChanges(changes, { imageJob: null, image: ["IMG-A3F2"] });
    expect(changes).toEqual({ imageJob: null, image: null });
    const capped: DatabaseChanges = {};
    mergeDatabaseChanges(capped, {
      task: Array.from({ length: 200 }, (_, i) => `TSK-${i}`),
    });
    expect(capped.task).toHaveLength(200);
    mergeDatabaseChanges(capped, { task: ["TSK-EXTRA"] });
    expect(capped.task).toBeNull();
  });
});
