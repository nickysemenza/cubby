import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

const { executeEntityMutation } = vi.hoisted(() => ({
  executeEntityMutation: vi.fn(),
}));

vi.mock("~/entities/entity-mutation.functions", () => ({
  executeEntityMutation,
  flattenEntityMutationResult: (result: unknown) => result,
  // `useEntityCommands` spreads the kernel descriptor's options so the global
  // MutationCache sees `meta`; the stub only has to be spreadable.
  entityMutation: {
    mutate: {
      forEntity: () => ({ mutationOptions: () => ({}) }),
    },
  },
}));

import { StartOperationError } from "~/integrations/tanstack-query/start-transport";
import { useEntityCommands } from "./use-entity-commands";

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider
    client={
      new QueryClient({ defaultOptions: { mutations: { retry: false } } })
    }
  >
    {children}
  </QueryClientProvider>
);

const removeAndReadIssues = async () => {
  const { result } = renderHook(() => useEntityCommands("task"), { wrapper });
  const outcome = await result.current.remove(["TSK-4K7M"]);
  await waitFor(() => expect(outcome.ok).toBe(false));
  return outcome.ok ? [] : outcome.issues;
};

describe("useEntityCommands structured refusals", () => {
  it("attaches each validation issue to the field the server named", async () => {
    executeEntityMutation.mockRejectedValue(
      new StartOperationError({
        code: "BAD_REQUEST",
        reason: "INVALID_INPUT",
        message: "data.name: Required",
        validationIssues: [
          { code: "invalid_type", path: ["data", "name"], message: "Required" },
        ],
      }),
    );

    const issues = await removeAndReadIssues();

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
    executeEntityMutation.mockRejectedValue(
      new StartOperationError({
        code: "PRECONDITION_FAILED",
        reason: "DELETE_BLOCKED",
        message: "Task cannot be deleted",
        blockers: [
          {
            code: "task-has-subtasks",
            effect: "block",
            label: "Subtasks",
            description: "3 subtasks still reference this task.",
            total: 3,
            byTargetId: { "TSK-4K7M": 3 },
          },
        ] as never,
      }),
    );

    const issues = await removeAndReadIssues();

    expect(issues.map((issue) => issue.message)).toEqual([
      "Task cannot be deleted",
      "Subtasks: 3 subtasks still reference this task.",
    ]);
    expect(issues.every((issue) => issue.field === undefined)).toBe(true);
  });

  it("surfaces an authorization refusal as its own message", async () => {
    executeEntityMutation.mockRejectedValue(
      new StartOperationError({
        code: "UNAUTHORIZED",
        reason: "NOT_AUTHENTICATED",
        message: "Please sign in to continue",
      }),
    );

    expect(await removeAndReadIssues()).toEqual([
      { message: "Please sign in to continue", source: "server" },
    ]);
  });

  it("keeps a redacted unknown failure redacted", async () => {
    executeEntityMutation.mockRejectedValue(
      new StartOperationError({
        code: "INTERNAL_SERVER_ERROR",
        reason: "UNKNOWN_ERROR",
        message: "The operation could not be completed",
      }),
    );

    expect(await removeAndReadIssues()).toEqual([
      { message: "The operation could not be completed", source: "server" },
    ]);
  });
});
