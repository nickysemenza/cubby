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

function renderNavigator() {
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
  return openChanges;
}

describe("WorkspaceNavigator interactions", () => {
  it("marks active destinations and closes on navigation", () => {
    const openChanges = renderNavigator();
    expect(
      screen
        .getAllByRole("link", { name: "Projects" })
        .every((link) => link.getAttribute("aria-current") === "page"),
    ).toBe(true);
    expect(screen.getByRole("link", { name: "Records" })).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("link", { name: "Locations" })[0]);
    expect(openChanges).toContain(false);
  });

  it("searches across household and utility tiers", () => {
    renderNavigator();
    const search = screen.getByRole("textbox", {
      name: "Find a workspace destination",
    });
    fireEvent.change(search, { target: { value: "search debug" } });
    expect(
      screen.getByRole("link", { name: /Search debug/ }),
    ).toBeInTheDocument();
    expect(screen.getByText("Dev")).toBeInTheDocument();
    fireEvent.change(search, { target: { value: "" } });
    expect(
      screen.getByRole("button", { name: "Tools & data" }),
    ).toBeInTheDocument();
  });

  it("moves between household and utility views", () => {
    renderNavigator();
    fireEvent.click(screen.getByRole("button", { name: "Tools & data" }));
    const back = screen.getByRole("button", { name: "Back to household" });
    expect(back).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "More" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Dev" })).toBeInTheDocument();
    fireEvent.click(back);
    expect(
      screen.getByRole("button", { name: "Tools & data" }),
    ).toBeInTheDocument();
  });
});
