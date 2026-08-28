import { publicImpactItemSchema } from "@cubby/schemas/entity-integrity";
import { productTopLevelOut } from "@cubby/schemas/product";
import { testShortcode } from "@cubby/schemas/testing";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { entityMutation } from "~/entities/entity-mutation.functions";
import { StartOperationError } from "~/integrations/tanstack-query/start-transport";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";
import { mock } from "~/lib/test/mock-schema";
import { entityBrowserMutationResultSchema } from "~/server/entity-kernel/contracts";

import {
  createEntityMutationPort,
  type EntityMutationOperations,
  useEntityCommands,
} from "./use-entity-commands";

function refusalPort(error: StartOperationError) {
  const mutation = entityMutation.mutate.withTransport(async () => {
    throw error;
  });
  const operations: EntityMutationOperations = { mutation };
  return createEntityMutationPort(operations);
}

async function removeAndReadIssues(error: StartOperationError) {
  const harness = createBrowserTestHarness();
  const BrowserWrapper = harness.wrapper;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <BrowserWrapper>{children}</BrowserWrapper>
  );
  const { result, unmount } = renderHook(
    () => useEntityCommands("task", { mutationPort: refusalPort(error) }),
    { wrapper },
  );
  const outcome = await result.current.remove(["TSK-4K7M"]);
  unmount();
  harness.dispose();
  return outcome.ok ? [] : outcome.issues;
}

describe("useEntityCommands structured refusals", () => {
  it("retains side effects on schema-correlated create and update results", async () => {
    const sideEffects = { backgroundBatches: [] };
    const item = mock(productTopLevelOut, {
      seed: 31,
      overrides: {
        id: testShortcode("product", "PRD-4K7M"),
        externalIds: [],
      },
    });
    const mutation = entityMutation.mutate.withTransport(async () =>
      entityBrowserMutationResultSchema.parse({
        action: "update",
        entity: "product",
        item,
        sideEffects,
      }),
    );
    const port = createEntityMutationPort({ mutation });

    const execution = await port.execute({
      entity: "product",
      operation: "update",
      intent: "full",
      id: item.id,
      data: { name: item.name },
    });

    expect(execution.result).toMatchObject({
      id: item.id,
      sideEffects,
    });
  });

  it("attaches each validation issue to the field the server named", async () => {
    const issues = await removeAndReadIssues(
      new StartOperationError({
        code: "BAD_REQUEST",
        reason: "INVALID_INPUT",
        message: "data.name: Required",
        validationIssues: [
          { code: "invalid_type", path: ["data", "name"], message: "Required" },
        ],
      }),
    );

    expect(issues).toContainEqual({
      field: "name",
      message: "Required",
      source: "server",
    });
    expect(issues[0]).toEqual({
      message: "data.name: Required",
      source: "server",
    });
  });

  it("reports each lifecycle blocker instead of one flattened sentence", async () => {
    const blocker = publicImpactItemSchema.parse({
      code: "task-has-subtasks",
      effect: "block",
      label: "Subtasks",
      description: "3 subtasks still reference this task.",
      total: 3,
      byTargetId: { "TSK-4K7M": 3 },
    });
    const issues = await removeAndReadIssues(
      new StartOperationError({
        code: "PRECONDITION_FAILED",
        reason: "DELETE_BLOCKED",
        message: "Task cannot be deleted",
        blockers: [blocker],
      }),
    );

    expect(issues.map((issue) => issue.message)).toEqual([
      "Task cannot be deleted",
      "Subtasks: 3 subtasks still reference this task.",
    ]);
    expect(issues.every((issue) => issue.field === undefined)).toBe(true);
  });

  it("surfaces an authorization refusal as its own message", async () => {
    expect(
      await removeAndReadIssues(
        new StartOperationError({
          code: "UNAUTHORIZED",
          reason: "NOT_AUTHENTICATED",
          message: "Please sign in to continue",
        }),
      ),
    ).toEqual([{ message: "Please sign in to continue", source: "server" }]);
  });

  it("keeps a redacted unknown failure redacted", async () => {
    expect(
      await removeAndReadIssues(
        new StartOperationError({
          code: "INTERNAL_SERVER_ERROR",
          reason: "UNKNOWN_ERROR",
          message: "The operation could not be completed",
        }),
      ),
    ).toEqual([
      { message: "The operation could not be completed", source: "server" },
    ]);
  });
});
