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
 * A `lifecycle: "readOnly"` declaration (run) is served by the kernel for
 * get, list and search only; a cookbook is kernel-read and edit-only, with
 * no create. Failure modes: an entity missing from the kernel roster (its
 * bespoke reads survive), or a write reaching its repository because only the
 * MCP exposure — not the kernel — gates it.
 */
describe("kernel read-only boundaries", () => {
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
      sort: [{ orderBy: "name", direction: "asc" }],
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

  it("refuses cookbook create and every write to a read-only entity", async () => {
    const id = await seedCookbook("Refused Writes");
    // Cookbooks are born from an EPUB import: no create command variant
    // exists, so the command schema refuses it before any repository.
    const create = {
      action: "create",
      entity: "cookbook",
      data: { name: "x" },
    };
    // SAFETY: a deliberately invalid command exercises the kernel refusal.
    await expect(executeEntity(context(), create as never)).rejects.toThrow(
      /cookbook|invalid/i,
    );
    // Delete is one command shape for every kernel entity; the kernel itself
    // refuses it for a read-only declaration.
    await expect(
      executeEntity(context(), {
        action: "delete",
        entity: "run",
        ids: ["RUN-4K7M"],
      }),
    ).rejects.toMatchObject({ reason: "CONSTRAINT_VIOLATION" });
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
