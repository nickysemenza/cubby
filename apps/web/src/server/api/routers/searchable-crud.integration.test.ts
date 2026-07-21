import type { ProjectId } from "@cubby/schemas/identifiers";
import { projectCreateInput } from "@cubby/schemas/project";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, expectTypeOf, it } from "vitest";
import { mock } from "~/lib/test/mock-schema";
import { createTestCaller } from "~/server/api/trpc";
import { listBackgroundBatches } from "~/server/repo/background-jobs";
import { projectRouter } from "./project";

describe("searchable CRUD factory", () => {
  const ctx = withTestDb();

  it("preserves branded IDs and runs create/update embedding side effects", async () => {
    const caller = createTestCaller(projectRouter, ctx.db);
    const created = await caller.create(
      mock(projectCreateInput, {
        overrides: { name: "Searchable CRUD project" },
      }),
    );
    expectTypeOf(created.id).toEqualTypeOf<ProjectId>();

    const updated = await caller.update({
      id: created.id,
      data: { name: "Updated searchable CRUD project" },
    });
    expect(updated.id).toBe(created.id);

    const batches = await listBackgroundBatches(ctx.db, 20);
    expect(
      batches.filter((batch) => batch.kind === "entity-embedding.refresh"),
    ).toHaveLength(2);
  });
});
