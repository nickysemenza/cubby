import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ShelfGrid } from "~/app/_components/data-table/shelf";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { EntityShelf } from "./entity-shelf";

let harness: ReturnType<typeof createBrowserTestHarness> | undefined;
afterEach(() => {
  harness?.dispose();
});

describe("entity cards", () => {
  it.each([false, true])(
    "shows every server group and full count with compact=%s before later cards load",
    (compact) => {
      render(
        <ShelfGrid
          items={[{ id: "loaded", group: "b" }]}
          renderCard={(item) => <div key={item.id}>{item.id}</div>}
          groups={[
            { key: "a", label: "First group", count: 4 },
            { key: "b", label: "Second group", count: 9 },
          ]}
          getGroupKey={(item) => item.group}
          compact={compact}
        />,
      );
      expect(
        screen
          .getAllByRole("heading", { level: 2 })
          .map((heading) => heading.textContent),
      ).toEqual(["First group", "Second group"]);
      expect(screen.getByText("4")).toBeVisible();
      expect(screen.getByText("9")).toBeVisible();
      expect(screen.getByText("loaded")).toBeVisible();
    },
  );

  it("uses uploaded image records directly and keeps unfinished uploads as icon tiles", () => {
    harness = createBrowserTestHarness();
    render(
      <EntityShelf
        entity="image"
        items={[
          {
            id: "IMG-2345",
            filename: "Uploaded photo",
            status: "UPLOADED",
            url: "https://example.com/photo.jpg",
          },
          {
            id: "IMG-6789",
            filename: "Pending photo",
            status: "PENDING",
            url: "https://example.com/pending.jpg",
          },
        ]}
      />,
      { wrapper: harness.wrapper },
    );
    expect(screen.getByRole("img", { name: "Uploaded photo" })).toHaveAttribute(
      "src",
      expect.stringContaining("photo.jpg"),
    );
    expect(
      screen.getByRole("img", { name: "Pending photo" }),
    ).not.toHaveAttribute("src");
    expect(screen.getByRole("link", { name: "Pending photo" })).toHaveAttribute(
      "href",
      "/images/IMG-6789",
    );
  });

  it("retains loaded cards after a page failure and exposes retry", () => {
    harness = createBrowserTestHarness();
    const retry = vi.fn();
    render(
      <ShelfGrid
        items={["Loaded record"]}
        renderCard={(item) => <div key={item}>{item}</div>}
        error={new Error("Page unavailable")}
        onRetry={retry}
      />,
      { wrapper: harness.wrapper },
    );
    expect(screen.getByText("Loaded record")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledOnce();
  });
});
