import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { WorkspaceNavigator } from "./workspace-navigator";

let harness: ReturnType<typeof createBrowserTestHarness>;

beforeEach(() => {
  harness = createBrowserTestHarness();
});

afterEach(() => {
  harness.dispose();
});

describe("WorkspaceNavigator interactions", () => {
  it("searches all tiers, transitions views, marks active routes, and closes on navigation", () => {
    const openChanges: boolean[] = [];
    render(
      <WorkspaceNavigator
        open
        onOpenChange={(open) => openChanges.push(open)}
        initialView="household"
        activeTo="/projects"
      />,
      { wrapper: harness.wrapper },
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
    fireEvent.click(screen.getAllByRole("link", { name: "Locations" })[0]);
    expect(openChanges).toContain(false);
  });
});
