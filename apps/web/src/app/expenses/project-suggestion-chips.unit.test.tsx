import type { ExpenseOut } from "@cubby/schemas/project";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ProjectSuggestionChips } from "./project-suggestion-chips";

const mocks = vi.hoisted(() => {
  const projectId = "PRJ-2ABC";
  return {
    projectId,
    projects: [
      {
        id: projectId,
        name: "Workshop refresh",
        effectiveStart: "2026-08-01",
        effectiveEnd: "2026-08-31",
      },
    ],
    affinity: [{ projectId, trade: "electrical", count: 2 }],
  };
});

const PROJECT_ID = mocks.projectId;

vi.mock("@tanstack/react-query", () => ({
  queryOptions: (options: unknown) => options,
  useQuery: (options: { meta?: { operation?: string } }) => ({
    data:
      options.meta?.operation === "project.options"
        ? mocks.projects
        : mocks.affinity,
  }),
}));

const expense = {
  id: "EXP-PLAN",
  projectId: null,
  date: "2026-08-12",
  trade: "electrical",
} as ExpenseOut;

describe("ProjectSuggestionChips", () => {
  it("does not assign until the selected proposal is accepted", () => {
    const onAssign = vi.fn().mockResolvedValue(undefined);
    render(
      <ProjectSuggestionChips
        expense={expense}
        isPending={false}
        onAssign={onAssign}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Workshop refresh" }));

    expect(onAssign).not.toHaveBeenCalled();
    expect(screen.getByText(/Assign to Workshop refresh/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Accept" }));

    expect(onAssign).toHaveBeenCalledWith(PROJECT_ID);
  });
});
