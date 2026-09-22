import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import {
  ApplicationDirectory,
  type ApplicationDirectoryMode,
} from "./application-directory";
import { recordViews } from "./application-views";

let harness: ReturnType<typeof createBrowserTestHarness>;
beforeEach(() => {
  harness = createBrowserTestHarness();
});
afterEach(() => {
  harness.dispose();
});

function Directory({ mode }: { mode: ApplicationDirectoryMode }) {
  const [query, setQuery] = useState("");
  return (
    <ApplicationDirectory mode={mode} query={query} onQueryChange={setQuery} />
  );
}

describe("application directory", () => {
  it("links every record type to its canonical list", async () => {
    render(<Directory mode="records" />, { wrapper: harness.wrapper });
    await screen.findByRole("heading", { name: "Records", level: 1 });
    const links = screen.getAllByRole("link");
    for (const view of recordViews) {
      const matches = links.filter(
        (link) => link.getAttribute("href") === view.to,
      );
      expect(matches).toHaveLength(1);
      const [link] = matches;
      expect(link).toHaveAttribute("href", view.to);
      expect(link).toHaveAccessibleName(view.label);
      expect(link).toHaveAccessibleDescription(view.description);
    }
    expect(screen.getByRole("status")).toHaveTextContent(
      "24 record types found",
    );
  });

  it("filters activities using their purpose and preserves direct links", async () => {
    render(<Directory mode="activities" />, { wrapper: harness.wrapper });
    const filter = await screen.findByRole("searchbox", {
      name: "Find an activity",
    });
    fireEvent.change(filter, { target: { value: "shopping" } });
    expect(
      screen.getByRole("link", { name: /Build a shopping list/ }),
    ).toHaveAttribute("href", "/meals/shopping-list");
    expect(
      screen.queryByRole("heading", { name: "House", level: 2 }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("1 activity found");
  });

  it("offers a working clear action when a filter matches nothing", async () => {
    render(<Directory mode="records" />, { wrapper: harness.wrapper });
    const filter = await screen.findByRole("searchbox", {
      name: "Find a record type",
    });
    fireEvent.change(filter, { target: { value: "no matching destination" } });
    expect(
      screen.getByRole("heading", { name: "No matching record types" }),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Clear filter" }));
    expect(filter).toHaveValue("");
    expect(screen.getByRole("status")).toHaveTextContent(
      "24 record types found",
    );
  });
});
