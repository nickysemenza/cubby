import {
  render as renderWithTestingLibrary,
  screen,
} from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { Page, usePageCount } from "./Page";

let harness: ReturnType<typeof createBrowserTestHarness>;

beforeEach(() => {
  harness = createBrowserTestHarness();
});

afterEach(() => {
  harness.dispose();
});

function render(element: ReactElement) {
  return renderWithTestingLibrary(element, { wrapper: harness.wrapper });
}

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
    expect(content.parentElement).toHaveClass(
      "mx-auto",
      "max-w-7xl",
      "px-2",
      "md:px-6",
    );
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
  it("gives non-ledger full-width renderers standard responsive gutters", () => {
    render(
      <Page variant="list" title="Products" layout="full" bodyGutter="standard">
        <p>Product shelf</p>
      </Page>,
    );

    expect(screen.getByText("Product shelf").parentElement).toHaveClass(
      "px-2",
      "md:px-6",
    );
  });

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
    expect(await screen.findByText("7 products")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Table" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "New" }).parentElement,
    ).toHaveClass("min-w-0", "overflow-x-auto");

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

  it("renders secondary detail actions once per width with that width's overflow", () => {
    const secondary = vi.fn((overflow: "inline" | "menu") => (
      <button type="button">{`Delete (${overflow})`}</button>
    ));
    render(
      <Page
        variant="detail"
        entity="product"
        title="Blue mug"
        heroActions={{
          primary: <button type="button">Edit</button>,
          secondary,
        }}
      >
        <p>Detail body</p>
      </Page>,
    );

    expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
    // The plate never wraps the verbs in a second popover: the `md+` copy is
    // told to spell verbs out inline, the phone copy to fold them behind its
    // own "More actions" menu.
    expect(secondary).toHaveBeenCalledWith("inline");
    expect(secondary).toHaveBeenCalledWith("menu");
    expect(
      screen.getByRole("button", { name: "Delete (inline)" }).parentElement,
    ).toHaveClass("md:flex");
    expect(
      screen.getByRole("button", { name: "Delete (menu)" }).parentElement,
    ).toHaveClass("md:hidden");
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
      "md:hidden",
    );
    expect(
      screen.getByTestId("detail-media").parentElement?.className,
    ).not.toContain("-mx-");
  });
});
