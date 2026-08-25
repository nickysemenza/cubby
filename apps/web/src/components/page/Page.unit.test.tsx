import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("~/hooks/useRouteEntity", () => ({
  useRouteEntity: () => undefined,
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    className,
  }: {
    children: ReactNode;
    to: string;
    className?: string;
  }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
}));

import { Page, usePageCount } from "./Page";

function CountReporter({ count }: { count: number }) {
  usePageCount(count);
  return null;
}

describe("Page bare variant", () => {
  it("keeps the shared page width without inventing a loading-page header", () => {
    render(
      <Page variant="bare">
        <p>Loading recipe export</p>
      </Page>,
    );

    const content = screen.getByText("Loading recipe export");
    expect(content.parentElement).toHaveClass("mx-auto", "max-w-7xl");
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
  });

  it("reserves a shell-aware viewport without negative margins", () => {
    render(
      <Page variant="bare" layout="viewport">
        <p>Pantry workspace</p>
      </Page>,
    );

    const viewport = screen.getByText("Pantry workspace").parentElement;
    expect(viewport).toHaveClass(
      "h-[calc(100dvh-var(--app-chrome-top)-var(--app-chrome-bottom))]",
      "overflow-hidden",
    );
    expect(viewport?.className).not.toContain("-mx-");
  });
});

describe("Page workbench", () => {
  it("keeps identity, modes, count, and creation action in the first tier", async () => {
    const { rerender } = render(
      <Page
        variant="list"
        entity="product"
        title="Products"
        listChrome="workbench"
        workbenchControls={<button type="button">Table</button>}
        actions={<button type="button">New</button>}
      >
        <CountReporter count={7} />
        <p>Table body</p>
      </Page>,
    );

    const identity = screen.getByRole("heading", { name: "Products" });
    expect(await screen.findByText("7")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Table" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New" })).toBeInTheDocument();

    rerender(
      <Page
        variant="list"
        entity="product"
        title="Products"
        listChrome="workbench"
        workbenchControls={<button type="button">Shelf</button>}
        actions={<button type="button">New</button>}
      >
        <CountReporter count={7} />
        <p>Shelf body</p>
      </Page>,
    );

    expect(screen.getByRole("heading", { name: "Products" })).toBe(identity);
    expect(screen.getByRole("button", { name: "Shelf" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New" })).toBeInTheDocument();
  });

  it("authors one visible detail action and collapsible secondary actions", () => {
    const { container } = render(
      <Page
        variant="detail"
        entity="product"
        title="Blue mug"
        heroActions={{
          primary: <button type="button">Edit</button>,
          secondary: <button type="button">Delete</button>,
        }}
      >
        <p>Detail body</p>
      </Page>,
    );

    expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
    const menuTrigger = screen.getByRole("button", {
      name: "Open detail actions",
    });
    expect(menuTrigger.parentElement).toHaveClass("md:hidden");
    expect(
      container.querySelector(".hidden.flex-wrap.items-center.gap-2.md\\:flex"),
    ).toBeInTheDocument();

    fireEvent.click(menuTrigger);
    expect(screen.getByText("Record actions")).toBeInTheDocument();
  });

  it("uses a viewport-aligned, overflow-safe wrapper for phone detail media", () => {
    render(
      <Page
        variant="detail"
        entity="location"
        title="Pantry shelf"
        heroMedia={<div data-testid="detail-media">Photo</div>}
      >
        <p>Detail body</p>
      </Page>,
    );

    expect(screen.getByTestId("detail-media").parentElement).toHaveClass(
      "left-1/2",
      "-mt-2",
      "w-screen",
      "-translate-x-1/2",
      "overflow-hidden",
    );
    expect(
      screen.getByTestId("detail-media").parentElement?.className,
    ).not.toContain("-mx-");
  });
});
