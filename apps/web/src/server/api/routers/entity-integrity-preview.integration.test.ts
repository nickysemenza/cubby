import { vendorCreateInput } from "@cubby/schemas/vendor";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { createVendor } from "~/server/repo/vendor";
import { previewOperation } from "./entity-integrity-preview";

/**
 * Coverage for `plan()`'s two gap cases in `entity-integrity-preview.ts` —
 * an id that resolves to nothing, and a non-ingredient merge with no
 * `keepId` — the two situations that used to produce a confident, empty,
 * WRONG preview instead of saying anything. There is no delete arm left to
 * cover: deletes have no preview any more (see the router's own doc
 * comment), so every case here is a merge.
 */
describe("entityIntegrity.previewOperation gap handling", () => {
  const ctx = withTestDb();

  it("blocks a merge whose mergeIds name nothing, instead of previewing nothing", async () => {
    const result = await previewOperation(
      ctx.db,
      { operation: "merge", entity: "vendor", mergeIds: ["VEN-ZZZZ"] },
      new Date(),
    );

    expect(result.canProceed).toBe(false);
    const blocker = result.blockers.find(
      (b) => b.code === "block-unresolved-target",
    );
    expect(blocker).toBeDefined();
    // The code must reach `label` — `ImpactRow` renders total/label/code and
    // never `description`, so a description-only message is invisible in the UI.
    expect(blocker?.label).toContain("VEN-ZZZZ");
    expect(blocker?.byTargetId).toHaveProperty("VEN-ZZZZ");
  });

  it("blocks when only SOME mergeIds resolve, rather than silently previewing the survivors", async () => {
    const { output: vendor } = await createVendor(
      ctx.db,
      vendorCreateInput.parse({ name: "Real Vendor" }),
      ctx.actor,
    );

    const result = await previewOperation(
      ctx.db,
      {
        operation: "merge",
        entity: "vendor",
        mergeIds: [vendor.id, "VEN-ZZZY"],
      },
      new Date(),
    );

    expect(result.canProceed).toBe(false);
    const blocker = result.blockers.find(
      (b) => b.code === "block-unresolved-target",
    );
    expect(blocker?.label).toContain("VEN-ZZZY");
    // Only the unknown one is named; the real vendor is not a blocker.
    expect(blocker?.label).not.toContain(vendor.id);
  });

  it("blocks a merge whose keepId names nothing", async () => {
    const { output: keep } = await createVendor(
      ctx.db,
      vendorCreateInput.parse({ name: "Keeper Vendor" }),
      ctx.actor,
    );

    const result = await previewOperation(
      ctx.db,
      {
        operation: "merge",
        entity: "vendor",
        mergeIds: [keep.id],
        keepId: "VEN-ZZZZ",
      },
      new Date(),
    );

    expect(result.canProceed).toBe(false);
    expect(result.blockers.map((b) => b.code)).toContain(
      "block-unresolved-target",
    );
  });

  it("blocks a non-ingredient merge preview with no keepId", async () => {
    // `keepId` is optional in the wire schema, but only ingredient can answer
    // "which should I keep" (candidate ranking). The others used to receive an
    // empty-string keeper and return a confident preview of an impossible merge.
    const { output: a } = await createVendor(
      ctx.db,
      vendorCreateInput.parse({ name: "Merge A" }),
      ctx.actor,
    );
    const { output: b } = await createVendor(
      ctx.db,
      vendorCreateInput.parse({ name: "Merge B" }),
      ctx.actor,
    );

    const result = await previewOperation(
      ctx.db,
      { operation: "merge", entity: "vendor", mergeIds: [a.id, b.id] },
      new Date(),
    );

    expect(result.canProceed).toBe(false);
    expect(result.blockers.map((b) => b.code)).toContain(
      "block-missing-keeper",
    );
  });
});
