import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Page } from "./Page";

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
