import { beforeEach, describe, expect, it } from "vitest";
import { type PrismaClient } from "@prisma/client";
import { buildTestDB } from "tooling/test-setup";
import { insertDataConfig } from "./system";
import { config } from "~/testdata/data-config";
import { createCallerFactory } from "../trpc";
import { appRouter } from "../root";

let prisma: PrismaClient;
describe("system test", () => {
  beforeEach(async () => {
    // Get a isolated test database
    const res = await buildTestDB();
    prisma = res.prisma;
    return res.teardown;
  });
  it("load data config", async () => {
    await insertDataConfig(prisma, config);

    const createCaller = createCallerFactory(appRouter);
    const caller = createCaller({
      headers: new Headers(),
      db: prisma,
      auth: undefined,
    });
    const list = await caller.ingredient.list({
      pagination: { pageSize: 12 },
      filters: {},
    });
    expect(list.items.length).toEqual(12);
    const eggs = await caller.ingredient.getByName({
      nameFilter: "large eggs",
    });
    expect(eggs).not.toBeNull();
    if (eggs === null) {
      return;
    }
    expect(eggs.name).toBe("large brown eggs");
  });
});
