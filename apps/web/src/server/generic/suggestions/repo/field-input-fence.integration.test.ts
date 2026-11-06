import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { buildEntity } from "tooling/factories/build";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import {
  kernelCtx,
  seedPending,
  suggestionStatus,
} from "~/server/domains/run/service/suggestion-sweep.fixtures";
import { executeEntityAs } from "~/server/entity-kernel";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";
import {
  fieldInputFingerprintIfLive,
  fieldInputFingerprintsIfLive,
  readFieldInputs,
} from "~/server/generic/suggestions/repo/field-input-fence";
import {
  acceptSuggestion,
  readFieldSuggestions,
} from "~/server/generic/suggestions/repo/suggestion-review";
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
    const otherParent = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "Synthetic unchanged parent", type: "house" }),
      ctx.actor,
    );
    const otherChild = await createLocationFixture(
      ctx.db,
      makeLocationInput({
        name: "Synthetic unchanged child",
        type: "area",
        parentId: otherParent.id,
      }),
      ctx.actor,
    );
    const other = await seedPending(ctx, {
      entity: "location",
      recordId: otherChild.entityId,
      field: "type",
      currentValue: "area",
      suggestedValue: "room",
      kind: "correction",
    });
    expect(
      (await readFieldSuggestions(ctx.db, [pending.id, other.id]))
        .map((row) => row.id)
        .sort(),
    ).toEqual([pending.id, other.id].sort());
    const childSubject = {
      entity: "location",
      recordId: child.entityId,
      field: "type",
    };
    const otherSubject = { ...childSubject, recordId: otherChild.entityId };
    const missingProduct = randomUUID();
    const subjects = [
      childSubject,
      otherSubject,
      childSubject,
      { entity: "product", recordId: missingProduct, field: "categoryId" },
    ];
    const reads = await readFieldInputs(ctx.db, subjects);
    expect(reads.map((read) => read.fingerprint)).toEqual(
      await fieldInputFingerprintsIfLive(ctx.db, subjects),
    );
    expect(reads[0]?.fingerprint).toBe(
      await fieldInputFingerprintIfLive(
        ctx.db,
        "location",
        child.entityId,
        "type",
      ),
    );
    expect(reads[3]?.fingerprint).toBeNull();
    await executeEntityAs(kernelCtx(ctx), "update", {
      entity: "location",
      id: parent.id,
      data: { name: "Synthetic renamed parent room" },
    });
    await expect(
      acceptSuggestion(ctx.db, kernelCtx(ctx), { id: pending.id }),
    ).rejects.toThrow("Suggestion inputs changed");
    expect(await readFieldSuggestions(ctx.db, [pending.id, other.id])).toEqual([
      expect.objectContaining({ id: other.id }),
    ]);
    expect(await suggestionStatus(ctx.db, pending.id)).toBe("pending");

    // Restoring either deleted row must be able to revive an ineligible proposal.
    await getDb(ctx.db).execute(
      sql`UPDATE "Location" SET "deletedAt" = now() WHERE id = ${otherParent.entityId}::uuid`,
    );
    const [otherAfterDelete, deletedParent] = await readFieldInputs(ctx.db, [
      otherSubject,
      { ...childSubject, recordId: otherParent.entityId },
    ]);
    expect(otherAfterDelete?.fingerprint).not.toBe(reads[1]?.fingerprint);
    expect(deletedParent?.fingerprint).toBeNull();
  });

  it("refuses Task advice after reparenting between parents without a Project", async () => {
    const create = async (name: string, parentTaskId?: string) =>
      (
        await executeEntityAs(kernelCtx(ctx), "create", {
          entity: "task",
          data: buildEntity("task", {
            name,
            trade: "other",
            ...(parentTaskId ? { parentTaskId } : {}),
          }),
        })
      ).item;
    const first = await create("Synthetic first parent");
    const second = await create("Synthetic second parent");
    const child = await create("Synthetic child", first.id);
    const project = (
      await executeEntityAs(kernelCtx(ctx), "create", {
        entity: "project",
        data: buildEntity("project", { name: "Synthetic Project" }),
      })
    ).item;
    const pending = await seedPending(ctx, {
      entity: "task",
      recordId: await resolveOrThrow(ctx.db, "task", child.id),
      field: "projectId",
      currentValue: null,
      suggestedValue: project.id,
      kind: "addition",
    });
    await executeEntityAs(kernelCtx(ctx), "update", {
      entity: "task",
      id: child.id,
      data: { parentTaskId: second.id },
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
