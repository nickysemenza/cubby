import { expect, it, vi } from "vitest";

it("initializes Meal read ports from the cold operation entry point", async () => {
  vi.resetModules();
  await import("~/server/domains/meal/operations.server");
  const { repositoryReadPorts } =
    await import("~/server/entity-kernel/repo/read-ports");
  expect(repositoryReadPorts("meal")).toBeDefined();
});
