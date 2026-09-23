import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { dashboard } from "~/lib/dashboard.functions";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { mobileHouseholdItems } from "./nav-items";
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
      initialView="household"
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
      mobileHouseholdItems.find((item) => item.to === "/projects")?.entity,
    ).toBe("project");
    renderNavigator();
    expect(
      screen.getAllByRole("link", { name: /Projects/ })[0],
    ).toHaveTextContent("0 records");
    expect(
      screen.getAllByRole("link", { name: "Household calendar" }).length,
    ).toBeGreaterThan(0);
  });

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
