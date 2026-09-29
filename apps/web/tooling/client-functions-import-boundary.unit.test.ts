import { describe, expect, it } from "vitest";
import { START_OPERATIONS } from "~/lib/generated/start-operation-registry.gen";
import { START_OPERATION_HANDLER_LOADERS } from "~/server/generated/start-operation-handlers.gen";

// The browser-loaded operation policy (`operation-overrides.ts`, imported by the
// generated client catalog) is held to the server-import boundary by the
// `no-restricted-imports` override scoped to it in `.oxlintrc.json`, and the
// generator's `assertClientSafeImports` — see docs/agents/validation.md.

describe("client function import boundary", () => {
  it("keeps generated operation handlers complete", () => {
    const dispatchableOperations = Object.entries(START_OPERATIONS)
      .filter(([, definition]) => definition.kind !== "subscription")
      .map(([operation]) => operation)
      .sort();

    expect(Object.keys(START_OPERATION_HANDLER_LOADERS).sort()).toEqual(
      dispatchableOperations,
    );
  });
});
