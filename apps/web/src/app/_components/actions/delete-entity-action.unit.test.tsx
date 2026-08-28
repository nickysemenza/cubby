import { act, render, waitFor } from "@testing-library/react";
import { useEffect, useRef } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  deleteDescriptionForEntity,
  useDeleteEntityAction,
} from "./delete-entity-action";

const mocks = vi.hoisted(() => ({
  remove: vi.fn(),
  navigate: vi.fn(),
  toastSuccess: vi.fn(),
  dialogProps: null as {
    error?: unknown;
    onSubmit: () => Promise<void>;
  } | null,
}));

vi.mock("~/entities/editing/use-entity-commands", () => ({
  useEntityCommands: () => ({ remove: mocks.remove, isPending: false }),
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
}));
vi.mock("sonner", () => ({ toast: { success: mocks.toastSuccess } }));
vi.mock("~/components/dialogs/bulk-action-dialog", () => ({
  BulkActionDialog: (props: typeof mocks.dialogProps) => {
    mocks.dialogProps = props;
    return null;
  },
}));

describe("generated CRUD delete action", () => {
  function Harness({ entity }: { entity: "expense" | "project" }) {
    const action = useDeleteEntityAction(entity);
    const started = useRef(false);
    useEffect(() => {
      if (!started.current) {
        started.current = true;
        if (action.run) void action.run([{ id: "x1", name: "Record" }]);
      }
    }, [action]);
    return action.dialog;
  }

  it("stages, reports success, and navigates after removal", async () => {
    mocks.remove.mockResolvedValueOnce({
      ok: true,
      result: { sideEffects: { backgroundBatches: [] } },
    });
    render(<Harness entity="expense" />);
    await waitFor(() => expect(mocks.dialogProps).not.toBeNull());
    await act(async () => mocks.dialogProps!.onSubmit());
    expect(mocks.remove).toHaveBeenCalledWith(["x1"]);
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Expense deleted.");
    expect(mocks.navigate).toHaveBeenCalledWith({ to: "/expenses" });
  });

  it("keeps the dialog open and reports refusal issues", async () => {
    mocks.remove.mockResolvedValueOnce({
      ok: false,
      issues: [{ message: "Has dependents" }],
    });
    mocks.dialogProps = null;
    render(<Harness entity="project" />);
    await waitFor(() => expect(mocks.dialogProps).not.toBeNull());
    await act(async () => mocks.dialogProps!.onSubmit());
    await waitFor(() => expect(mocks.dialogProps?.error).toBeTruthy());
    expect(mocks.navigate).toHaveBeenCalledTimes(1);
    expect(deleteDescriptionForEntity("task", { subtaskCount: 1 })).toContain(
      "deletes 1 subtask",
    );
  });
});
