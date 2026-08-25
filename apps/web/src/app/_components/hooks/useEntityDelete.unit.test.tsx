import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ remove: vi.fn(), navigate: vi.fn() }));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
}));
vi.mock("~/entities/editing/use-entity-commands", () => ({
  useEntityCommands: () => ({ isPending: false, remove: mocks.remove }),
}));
vi.mock("./useActionMutation", () => ({
  useActionMutation: () => ({ isPending: false, mutateAsync: vi.fn() }),
}));

import { useEntityDelete } from "./useEntityDelete";

function DeleteHarness() {
  const { deleteDialog, openDeleteDialog } = useEntityDelete({
    id: "TSK-4K7M",
    name: "Frame the wall",
    entity: "task",
    mutationOptions: () => ({}),
    redirectTo: "/tasks",
  });
  return (
    <>
      <button type="button" onClick={openDeleteDialog}>
        open
      </button>
      {deleteDialog}
    </>
  );
}

describe("useEntityDelete refusal reporting", () => {
  it("shows the lifecycle blockers that stopped the delete", async () => {
    mocks.remove.mockResolvedValue({
      ok: false,
      issues: [
        { message: "Task cannot be deleted", source: "server" },
        {
          message: "Subtasks: 3 subtasks still reference this task.",
          source: "server",
        },
      ],
    });

    render(<DeleteHarness />);
    fireEvent.click(screen.getByRole("button", { name: "open" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() =>
      expect(screen.getByText("Task cannot be deleted")).toBeInTheDocument(),
    );
    expect(
      screen.getByText("Subtasks: 3 subtasks still reference this task."),
    ).toBeInTheDocument();
    // A refused delete leaves the dialog open so the blockers stay readable.
    expect(mocks.navigate).not.toHaveBeenCalled();
  });
});
