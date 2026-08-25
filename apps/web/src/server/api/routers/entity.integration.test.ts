import { unsafeUserId } from "@cubby/schemas/identifiers";
import { vendorCreateInput, vendorOut } from "@cubby/schemas/vendor";
import { wishCreateInput, wishOut } from "@cubby/schemas/wish";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { mock } from "~/lib/test/mock-schema";
import { executeEntity } from "~/server/entity-kernel";
import { requireActor } from "~/server/request-context";
import { createTestCaller, createTestTRPCContext } from "../trpc";
import { entityRouter } from "./entity";

describe("entity kernel tRPC adapter", () => {
  const ctx = withTestDb();
  const kernelContext = () =>
    requireActor(
      createTestTRPCContext(ctx.db, {
        auth: { userId: unsafeUserId("test-user-id") },
      }),
    );

  it("runs public-shortcode CRUD through the thin write adapter", async () => {
    const caller = createTestCaller(entityRouter, ctx.db);
    const context = kernelContext();
    const created = await caller.mutate({
      action: "create",
      entity: "wish",
      data: mock(wishCreateInput, {
        overrides: { name: "Kernel contract wish" },
      }),
    });
    expect(created.action).toBe("create");
    if (created.action !== "create") throw new Error("unreachable");
    const createdWish = wishOut.parse(created.item);
    expect(createdWish.id).toMatch(/^WSH-/);
    expect(created.sideEffects.backgroundBatches).toEqual(expect.any(Array));

    const fetched = await executeEntity(context, {
      action: "get",
      entity: "wish",
      id: createdWish.id,
      missing: "error",
    });
    expect(fetched.action).toBe("get");
    if (fetched.action !== "get") throw new Error("unreachable");
    expect(wishOut.parse(fetched.item).name).toBe("Kernel contract wish");

    const listed = await executeEntity(context, {
      action: "list",
      entity: "wish",
      filters: { search: "Kernel contract wish" },
      sort: { orderBy: "name", direction: "asc" },
      pagination: { pageIndex: 0, pageSize: 10 },
    });
    expect(listed.action).toBe("list");
    if (listed.action !== "list") throw new Error("unreachable");
    expect(listed.items.map((item) => wishOut.parse(item).id)).toContain(
      createdWish.id,
    );

    const updated = await caller.mutate({
      action: "update",
      entity: "wish",
      id: createdWish.id,
      data: { name: "Kernel contract wish updated" },
    });
    expect(updated.action).toBe("update");
    if (updated.action !== "update") throw new Error("unreachable");
    expect(wishOut.parse(updated.item).name).toBe(
      "Kernel contract wish updated",
    );

    const removed = await caller.mutate({
      action: "delete",
      entity: "wish",
      ids: [createdWish.id],
    });
    expect(removed).toMatchObject({
      action: "delete",
      entity: "wish",
      deleted: 1,
      deletedReferences: [{ entity: "wish", id: createdWish.id }],
      affectedEdges: expect.any(Array),
      sideEffects: { backgroundBatches: expect.any(Array) },
    });
  });

  it("rejects the wrong public-id prefix and undeclared sort fields", async () => {
    const context = kernelContext();
    await expect(
      executeEntity(context, {
        action: "get",
        entity: "wish",
        id: "VND-ABC123",
        missing: "error",
      }),
    ).rejects.toThrow();
    await expect(
      executeEntity(context, {
        action: "list",
        entity: "wish",
        filters: {},
        sort: { orderBy: "definitelyNotAField", direction: "asc" },
      }),
    ).rejects.toThrow();
  });

  it("runs merge policy, transaction, cleanup, and side effects in order", async () => {
    const caller = createTestCaller(entityRouter, ctx.db);
    const keeper = await caller.mutate({
      action: "create",
      entity: "vendor",
      data: mock(vendorCreateInput, {
        overrides: { name: "Kernel keeper vendor" },
      }),
    });
    const loser = await caller.mutate({
      action: "create",
      entity: "vendor",
      data: mock(vendorCreateInput, {
        overrides: { name: "Kernel loser vendor" },
      }),
    });
    if (keeper.action !== "create" || loser.action !== "create") {
      throw new Error("unreachable");
    }
    const keeperId = vendorOut.parse(keeper.item).id;
    const loserId = vendorOut.parse(loser.item).id;

    const merged = await caller.mutate({
      action: "merge",
      entity: "vendor",
      data: { keepId: keeperId, mergeIds: [loserId] },
    });
    expect(merged.action).toBe("merge");
    if (merged.action !== "merge") throw new Error("unreachable");
    expect(vendorOut.parse(merged.item).id).toBe(keeperId);
    expect(merged.mergeSummary).toMatchObject({
      keepId: keeperId,
      deletedIds: [loserId],
      merged: 1,
    });
    expect(merged.sideEffects.backgroundBatches).toEqual(expect.any(Array));
  });

  it("runs relation attach, idempotency, and detach through the kernel", async () => {
    const caller = createTestCaller(entityRouter, ctx.db);
    const createProduct = async (name: string) => {
      const created = await caller.mutate({
        action: "create",
        entity: "product",
        data: mock(productCreateInput, { overrides: { name } }),
      });
      if (created.action !== "create") throw new Error("unreachable");
      return productTopLevelOut.parse(created.item).id;
    };
    const kitId = await createProduct("Kernel relation kit");
    const componentId = await createProduct("Kernel relation component");

    const attached = await caller.mutate({
      action: "attach",
      entity: "product",
      relation: "components",
      id: kitId,
      items: [{ id: componentId, quantity: 3 }],
    });
    expect(attached).toMatchObject({
      action: "attach",
      entity: "product",
      relation: "components",
      result: { changed: 1, attached: 1, alreadySatisfied: 0 },
    });

    const repeated = await caller.mutate({
      action: "attach",
      entity: "product",
      relation: "components",
      id: kitId,
      items: [{ id: componentId, quantity: 3 }],
    });
    expect(repeated).toMatchObject({
      action: "attach",
      result: { changed: 0, attached: 1, alreadySatisfied: 1 },
    });

    const detached = await caller.mutate({
      action: "detach",
      entity: "product",
      relation: "components",
      id: kitId,
      items: [{ id: componentId }],
    });
    expect(detached).toMatchObject({
      action: "detach",
      result: { changed: 1, attached: 0, alreadySatisfied: 0 },
    });
  });
});

import { productCreateInput, productTopLevelOut } from "@cubby/schemas/product";
