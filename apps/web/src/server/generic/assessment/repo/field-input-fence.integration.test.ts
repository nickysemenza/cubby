import { randomUUID } from "node:crypto";

import { assessmentReadScopedSourceKind } from "@cubby/schemas/assessment-read-publication";
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
import {
  fieldInputFingerprintIfLive,
  fieldInputFingerprintsIfLive,
  readFieldInputs,
  fieldInputAssessmentIdsSql,
  type FieldInputRead,
} from "~/server/generic/assessment/repo/field-input-fence";
import {
  acceptSuggestion,
  readFieldSuggestions,
} from "~/server/generic/assessment/repo/suggestion-review";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";
import {
  createLocationFixture,
  makeLocationInput,
} from "~/server/testing/repo.fixtures";

const { fieldWrite, productClassification } =
  assessmentReadScopedSourceKind.enum;
const dependencies = (read: FieldInputRead | undefined) =>
  new Set(
    read?.dependencies.map(
      ({ sourceKind, sourceId }) => `${sourceKind}:${sourceId}`,
    ),
  );

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
    const observed = new Map<string, FieldInputRead>();
    expect(
      (
        await readFieldSuggestions(ctx.db, [pending.id, other.id], (id, read) =>
          observed.set(id, read),
        )
      )
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
    expect(observed.get(pending.id)).toEqual(reads[0]);
    expect(observed.get(other.id)).toEqual(reads[1]);
    const affected = async (kind: string, id: string) =>
      (
        await getDb(ctx.db).execute(
          fieldInputAssessmentIdsSql(kind, sql`SELECT ${id}::uuid AS id`),
        )
      ).rows
        .map((row) => row.id)
        .sort();
    // Forward selection works before any retained dependency has been written.
    expect(await affected("location", parent.entityId)).toEqual([pending.id]);
    expect(await affected("location", otherParent.entityId)).toEqual([
      other.id,
    ]);
    expect(await affected(fieldWrite, child.entityId)).toEqual([pending.id]);
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
    const childDependencies = new Set([
      `${fieldWrite}:${child.entityId}`,
      `location:${child.entityId}`,
      `location:${parent.entityId}`,
    ]);
    expect(reads.map((read) => dependencies(read))).toEqual([
      childDependencies,
      new Set([
        `${fieldWrite}:${otherChild.entityId}`,
        `location:${otherChild.entityId}`,
        `location:${otherParent.entityId}`,
      ]),
      childDependencies,
      new Set([
        `${fieldWrite}:${missingProduct}`,
        `${productClassification}:${missingProduct}`,
        `product:${missingProduct}`,
      ]),
    ]);
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
    const hidden = new Map<string, FieldInputRead>();
    await readFieldSuggestions(ctx.db, [pending.id], (id, read) =>
      hidden.set(id, read),
    );
    expect(dependencies(hidden.get(pending.id))).toEqual(childDependencies);

    // Restoring either deleted row must be able to revive an ineligible proposal.
    await getDb(ctx.db).execute(
      sql`UPDATE "Location" SET "deletedAt" = now() WHERE id = ${otherParent.entityId}::uuid`,
    );
    const [otherAfterDelete, deletedParent] = await readFieldInputs(ctx.db, [
      otherSubject,
      { ...childSubject, recordId: otherParent.entityId },
    ]);
    expect(otherAfterDelete?.fingerprint).not.toBe(reads[1]?.fingerprint);
    expect(dependencies(otherAfterDelete)).toEqual(dependencies(reads[1]));
    expect(deletedParent?.fingerprint).toBeNull();
    expect(dependencies(deletedParent)).toEqual(
      new Set([
        `${fieldWrite}:${otherParent.entityId}`,
        `location:${otherParent.entityId}`,
      ]),
    );
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
    const affected = async (id: string) =>
      (
        await getDb(ctx.db).execute(
          fieldInputAssessmentIdsSql("task", sql`SELECT ${id}::uuid AS id`),
        )
      ).rows.map((row) => row.id);
    expect(
      await affected(await resolveOrThrow(ctx.db, "task", second.id)),
    ).toEqual([pending.id]);
    expect(
      await affected(await resolveOrThrow(ctx.db, "task", first.id)),
    ).toEqual([]);
    const [reparented] = await readFieldInputs(ctx.db, [
      {
        entity: "task",
        recordId: await resolveOrThrow(ctx.db, "task", child.id),
        field: "projectId",
      },
    ]);
    expect(dependencies(reparented)).toContain(
      `task:${await resolveOrThrow(ctx.db, "task", second.id)}`,
    );
    expect(dependencies(reparented)).not.toContain(
      `task:${await resolveOrThrow(ctx.db, "task", first.id)}`,
    );
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
