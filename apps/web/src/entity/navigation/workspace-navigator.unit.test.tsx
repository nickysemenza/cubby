import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { dashboard } from "~/integrations/tanstack-query/generated/catalog/dashboard.gen";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { completeNavLeaves } from "./nav-items";
import { WorkspaceNavigator } from "./workspace-navigator";

let harness: ReturnType<typeof createBrowserTestHarness>;

beforeEach(() => {
  harness = createBrowserTestHarness();
  const queryKey = dashboard.counts.queryOptions().queryKey;
  harness.queryClient.setQueryDefaults(queryKey, { staleTime: Infinity });
  harness.queryClient.setQueryData(queryKey, {});
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
      activeTo="/projects"
    />,
    { wrapper: harness.wrapper },
  );
  return openChanges;
}

describe("WorkspaceNavigator interactions", () => {
  it("announces loaded roster counts but leaves workbenches unnumbered", () => {
    const queryKey = dashboard.counts.queryOptions().queryKey;
    harness.queryClient.setQueryData(queryKey, {
      project: 0,
    });
    expect(
      completeNavLeaves.find((item) => item.to === "/projects")?.entity,
    ).toBe("project");
    renderNavigator();
    expect(
      screen.getAllByRole("link", { name: /Projects/ })[0],
    ).toHaveTextContent("0 records");
    expect(
      screen.getAllByRole("link", { name: "Calendar" }).length,
    ).toBeGreaterThan(0);
  });

  it("marks active destinations and closes on navigation", () => {
    const openChanges = renderNavigator();
    expect(
      screen
        .getAllByRole("link", { name: "Projects" })
        .every((link) => link.getAttribute("aria-current") === "page"),
    ).toBe(true);
    expect(screen.getByRole("region", { name: "Records" })).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("link", { name: "Locations" })[0]);
    expect(openChanges).toContain(false);
  });

  it("searches across every section", () => {
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
    expect(screen.getByRole("link", { name: "Settings" })).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Search debug" }),
    ).toBeInTheDocument();
  });
});
