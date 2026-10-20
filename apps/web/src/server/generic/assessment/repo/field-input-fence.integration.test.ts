import { buildEntity } from "tooling/factories/build";
import { withTestDb } from "tooling/test-setup";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  kernelCtx,
  seedPending,
  suggestionStatus,
} from "~/server/domains/run/service/suggestion-sweep.fixtures";
import { executeEntityAs } from "~/server/entity-kernel";
import { acceptSuggestion } from "~/server/generic/assessment/repo/suggestion-review";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";
import {
  captureBackgroundQueue,
  drainDerivedRefreshFrontier,
} from "~/server/testing/background-queue";
import {
  createLocationFixture,
  makeLocationInput,
} from "~/server/testing/repo.fixtures";

// A displayed reference label is inference input; a member's unchanged save is intent.
describe("field input revision scope", () => {
  const ctx = withTestDb();
  let queue: ReturnType<typeof captureBackgroundQueue>;
  beforeEach(() => {
    queue = captureBackgroundQueue();
  });
  afterEach(() => queue.restore());

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
    await drainDerivedRefreshFrontier(ctx.db);
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
    await drainDerivedRefreshFrontier(ctx.db);
    expect(await suggestionStatus(ctx.db, pending.id)).toBe("superseded");
  });

  it("retires advice after an unchanged SpendingCategory decision", async () => {
    const category = (
      await executeEntityAs(kernelCtx(ctx), "create", {
        entity: "spendingCategory",
        data: buildEntity("spendingCategory", {
          name: "Synthetic explicit category",
          itemizationExpectation: "unknown",
        }),
      })
    ).item;
    await drainDerivedRefreshFrontier(ctx.db);
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
    await drainDerivedRefreshFrontier(ctx.db);
    expect(await suggestionStatus(ctx.db, pending.id)).toBe("superseded");
  });
});
