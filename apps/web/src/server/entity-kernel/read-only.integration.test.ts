import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  entityKernelContextSchema,
  executeEntity,
} from "~/server/entity-kernel";
import { upsertCookbook } from "~/server/repo/cookbook";
import { makeCookbookExtraction } from "~/server/repo/repo.fixtures";
import { createTestRequestContext } from "~/server/testing/request-context";

/**
 * A `lifecycle: "readOnly"` declaration is served by the kernel for get,
 * list and search only. Failure modes: a readOnly entity missing from the
 * kernel roster (its bespoke reads survive), or a write reaching its
 * repository because only the MCP exposure — not the kernel — gates it.
 */
describe("read-only kernel entities", () => {
  const ctx = withTestDb();
  const context = () =>
    entityKernelContextSchema.parse(
      createTestRequestContext(ctx.db, { auth: { userId: ctx.actor.userId } }),
    );

  const seedCookbook = async (name: string) =>
    (
      await upsertCookbook(
        ctx.db,
        {
          name,
          rawJson: makeCookbookExtraction(),
          author: ["Synthetic Author"],
          subjects: ["Baking"],
          sourceLabel: "synthetic.epub",
        },
        ctx.actor,
      )
    ).output.id;

  it("lists and reads a cookbook through the kernel", async () => {
    const id = await seedCookbook("Synthetic Loaves");
    await seedCookbook("Another Synthetic Book");

    const list = await executeEntity(context(), {
      action: "list",
      entity: "cookbook",
      filters: {},
      sort: { orderBy: "name", direction: "asc" },
    });
    if (list.action !== "list") throw new Error("expected list");
    expect(list.items.map((row) => row.book)).toEqual([
      "Another Synthetic Book",
      "Synthetic Loaves",
    ]);
    expect(list.meta.totalCount).toBe(2);

    const detail = await executeEntity(context(), {
      action: "get",
      entity: "cookbook",
      id,
      missing: "error",
    });
    if (detail.action !== "get") throw new Error("expected get");
    expect(detail.item).toMatchObject({
      id,
      book: "Synthetic Loaves",
      author: ["Synthetic Author"],
      recipeCount: 0,
    });
  });

  it("refuses create, update and delete for a read-only entity", async () => {
    const id = await seedCookbook("Refused Writes");
    // No create/update command variant exists for a read-only entity, so the
    // command schema refuses those before any repository is reached.
    for (const command of [
      { action: "create", entity: "cookbook", data: { name: "x" } },
      { action: "update", entity: "cookbook", id, data: { name: "x" } },
    ] as const) {
      // SAFETY: deliberately invalid commands exercise the kernel refusal.
      await expect(executeEntity(context(), command as never)).rejects.toThrow(
        /cookbook|invalid/i,
      );
    }
    // Delete is one command shape for every kernel entity; the kernel itself
    // refuses it for a read-only declaration.
    for (const [entity, code] of [
      ["cookbook", id],
      ["run", "RUN-4K7M"],
    ] as const) {
      await expect(
        executeEntity(context(), { action: "delete", entity, ids: [code] }),
      ).rejects.toMatchObject({ reason: "CONSTRAINT_VIOLATION" });
    }
    const detail = await executeEntity(context(), {
      action: "get",
      entity: "cookbook",
      id,
      missing: "error",
    });
    if (detail.action !== "get") throw new Error("expected get");
    expect(detail.item).toMatchObject({ book: "Refused Writes" });
  });
});
