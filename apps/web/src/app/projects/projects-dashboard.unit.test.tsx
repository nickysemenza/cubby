import type { ProjectOut } from "@cubby/schemas/project";
import { testShortcode } from "@cubby/schemas/testing";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { ProjectCard } from "./projects-dashboard";

vi.mock("@tanstack/react-router", () => ({
  getRouteApi: () => ({
    useSearch: () => ({}),
    useNavigate: () => vi.fn(),
  }),
  Link: ({
    children,
    onClick,
  }: {
    children: ReactNode;
    onClick?: React.MouseEventHandler<HTMLAnchorElement>;
  }) => (
    <a
      href="/projects/PRJ-CARD"
      onClick={(event) => {
        onClick?.(event);
        event.preventDefault();
      }}
    >
      {children}
    </a>
  ),
}));

function projectFixture(): ProjectOut {
  return {
    id: testShortcode("project", "card"),
    name: "Kitchen refresh",
    status: "planning",
    kind: null,
    locations: [],
    costEstimate: null,
    parentProjectId: null,
    startDate: null,
    endDate: null,
    icon: null,
    notes: null,
    googleDriveFolderUrl: null,
    notionPageUrl: null,
    dates: {
      derivedStart: null,
      derivedEnd: null,
      effectiveStart: null,
      effectiveEnd: null,
      startSource: "none",
      endSource: "none",
    },
    parentProjectName: null,
    childProjectIds: [],
    blockedByIds: [],
    blockingIds: [],
    createdAt: new Date("2026-08-27T00:00:00Z"),
    updatedAt: new Date("2026-08-27T00:00:00Z"),
    rollup: {
      spent: 0,
      actualSpent: 0,
      committedSpent: 0,
      contributions: 0,
      expenseCount: 0,
      taskCount: 0,
      doneTaskCount: 0,
      subtree: {
        spent: 0,
        actualSpent: 0,
        committedSpent: 0,
        contributions: 0,
        expenseCount: 0,
        taskCount: 0,
        doneTaskCount: 0,
        projectCount: 0,
        costEstimate: null,
      },
    },
  };
}

describe("ProjectCard inspection", () => {
  it("does not mark cards current when inspection is unavailable", () => {
    const project = projectFixture();

    render(<ProjectCard project={project} coverUrl={undefined} />);

    const titleLink = screen.getByRole("link", { name: /Kitchen refresh/ });
    expect(titleLink).not.toHaveAttribute("aria-current");
    expect(titleLink.closest('[data-slot="card"]')).not.toHaveAttribute(
      "data-current",
    );
  });

  it("keeps the title link canonical while the card body opens inspection", () => {
    const project = projectFixture();
    const onRowClick = vi.fn();
    const row = {
      id: project.id,
      getIsSelected: () => false,
      getToggleSelectedHandler: () => vi.fn(),
    };

    render(
      <ProjectCard
        project={project}
        coverUrl={undefined}
        inspection={{
          row,
          currentRowId: undefined,
          presentation: "dock",
          onRowClick,
          onRowHover: vi.fn(),
          onRowHoverEnd: vi.fn(),
        }}
      />,
    );

    const titleLink = screen.getByRole("link", { name: /Kitchen refresh/ });
    expect(titleLink).toHaveAttribute("href", "/projects/PRJ-CARD");
    fireEvent.click(titleLink);
    expect(onRowClick).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("Planning"));
    expect(onRowClick).toHaveBeenCalledOnce();
  });
});
