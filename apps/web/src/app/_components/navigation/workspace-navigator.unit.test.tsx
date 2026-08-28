import { fireEvent, render, screen } from "@testing-library/react";
import type { MouseEvent, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    search: _search,
    children,
    onClick,
    ...props
  }: {
    to: string;
    search?: Record<string, unknown>;
    children: ReactNode;
    onClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
  }) => (
    <a
      href={to}
      onClick={(event) => {
        event.preventDefault();
        onClick?.(event);
      }}
      {...props}
    >
      {children}
    </a>
  ),
}));

vi.mock("~/components/ui/responsive-sheet", () => ({
  ResponsiveSheet: ({
    open,
    title,
    children,
  }: {
    open: boolean;
    title: ReactNode;
    children: ReactNode;
  }) =>
    open ? (
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- The mocked primitive exposes ARIA semantics without native dialog behavior.
      <div role="dialog" aria-label={String(title)}>
        {children}
      </div>
    ) : null,
}));

import { WorkspaceNavigator } from "./workspace-navigator";

describe("WorkspaceNavigator interactions", () => {
  it("searches all tiers, transitions views, marks active routes, and closes on navigation", () => {
    const onOpenChange = vi.fn();
    render(
      <WorkspaceNavigator
        open
        onOpenChange={onOpenChange}
        initialView="household"
        activeTo="/projects"
      />,
    );

    expect(
      screen
        .getAllByRole("link", { name: "Projects" })
        .every((link) => link.getAttribute("aria-current") === "page"),
    ).toBe(true);

    const search = screen.getByRole("textbox", {
      name: "Find a workspace destination",
    });
    fireEvent.change(search, { target: { value: "background" } });
    expect(
      screen.getByRole("link", { name: /Background jobs/ }),
    ).toBeInTheDocument();
    expect(screen.getByText("Dev")).toBeInTheDocument();

    fireEvent.change(search, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Tools & data" }));
    expect(
      screen.getByRole("button", { name: "Back to household" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Data" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Dev" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Back to household" }));
    fireEvent.click(screen.getAllByRole("link", { name: "Locations" })[0]!);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
