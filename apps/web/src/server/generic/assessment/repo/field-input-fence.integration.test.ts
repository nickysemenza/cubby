import { buildEntity } from "tooling/factories/build";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  kernelCtx,
  seedPending,
  suggestionStatus,
} from "~/server/domains/run/service/suggestion-sweep.fixtures";
import { executeEntityAs } from "~/server/entity-kernel";
import {
  acceptSuggestion,
  readFieldSuggestions,
} from "~/server/generic/assessment/repo/suggestion-review";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";
import {
  createLocationFixture,
  makeLocationInput,
} from "~/server/testing/repo.fixtures";

// Changed input hides old advice and prevents applying it; unchanged saves keep it usable.
describe("current field suggestion inputs", () => {
  const ctx = withTestDb();
  it("refuses advice after a same-kind basis reference is renamed", async () => {
    const parent = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "Synthetic parent house", type: "house" }),
      ctx.actor,
    );
    const child = await createLocationFixture(
      ctx.db,
      makeLocationInput({
        name: "Synthetic child space",
        type: "area",
        parentId: parent.id,
      }),
      ctx.actor,
    );
    const pending = await seedPending(ctx, {
      entity: "location",
      recordId: child.entityId,
      field: "type",
      currentValue: "area",
      suggestedValue: "room",
      kind: "correction",
    });
    await executeEntityAs(kernelCtx(ctx), "update", {
      entity: "location",
      id: parent.id,
      data: { name: "Synthetic renamed parent room" },
    });
    await expect(
      acceptSuggestion(ctx.db, kernelCtx(ctx), { id: pending.id }),
    ).rejects.toThrow("Suggestion inputs changed");
    expect(await readFieldSuggestions(ctx.db, [pending.id])).toEqual([]);
    expect(await suggestionStatus(ctx.db, pending.id)).toBe("pending");
  });

  it("keeps advice available after an unchanged SpendingCategory save", async () => {
    const category = (
      await executeEntityAs(kernelCtx(ctx), "create", {
        entity: "spendingCategory",
        data: buildEntity("spendingCategory", {
          name: "Synthetic explicit category",
          itemizationExpectation: "unknown",
        }),
      })
    ).item;
    const pending = await seedPending(ctx, {
      entity: "spendingCategory",
      recordId: await resolveOrThrow(ctx.db, "spendingCategory", category.id),
      field: "itemizationExpectation",
      currentValue: "unknown",
      suggestedValue: "required",
      kind: "correction",
    });
    await executeEntityAs(kernelCtx(ctx), "update", {
      entity: "spendingCategory",
      id: category.id,
      data: { itemizationExpectation: "unknown" },
    });
    expect(await suggestionStatus(ctx.db, pending.id)).toBe("pending");
    expect(await readFieldSuggestions(ctx.db, [pending.id])).toEqual([
      expect.objectContaining({ id: pending.id }),
    ]);
  });
});
