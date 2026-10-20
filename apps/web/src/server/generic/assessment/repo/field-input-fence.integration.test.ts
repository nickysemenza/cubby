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
import { readInputRevisions } from "~/server/generic/derived-refresh/repo/revisions";
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

  // Audited writes already enrolled their root; the no-audit fallback must
  // not create a second Work generation and queue wake-up for the same edit.
  it("captures one refresh generation for an ordinary audited update", async () => {
    const subject = (
      await executeEntityAs(kernelCtx(ctx), "create", {
        entity: "spendingCategory",
        data: buildEntity("spendingCategory", {
          name: "Synthetic single capture category",
        }),
      })
    ).item;
    const id = await resolveOrThrow(ctx.db, "spendingCategory", subject.id);
    const key = `entity:spendingCategory:${id}`;
    const before = new Map(await readInputRevisions(ctx.db, [key])).get(key);
    await executeEntityAs(kernelCtx(ctx), "update", {
      entity: "spendingCategory",
      id: subject.id,
      data: { name: "Synthetic updated single capture category" },
    });
    const after = new Map(await readInputRevisions(ctx.db, [key])).get(key);
    expect(after).toBe((before ?? 0) + 1);
  });

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
