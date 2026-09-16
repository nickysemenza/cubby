import { describe, expect, it } from "vitest";
import { START_OPERATIONS } from "~/lib/generated/start-operation-registry.gen";
import { START_OPERATION_HANDLER_LOADERS } from "~/server/generated/start-operation-handlers.gen";

// The client operation modules (*.functions.ts) import boundary itself is now
// enforced by the `no-restricted-imports` override scoped to
// `apps/web/src/{app,entities,lib}/**/*.functions.ts` in `.oxlintrc.json`
// (paths: @tanstack/react-start, @cubby/db; patterns: ~/server/**, and
// ~/server-functions/** except the dispatch module) — see docs/agents/validation.md.

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
