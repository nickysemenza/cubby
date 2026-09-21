import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BasicInfo } from "~/components/common/basic-info";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";
import { EntityFilterLink } from "./entity-filter-link";

let harness: ReturnType<typeof createBrowserTestHarness>;

beforeEach(() => {
  harness = createBrowserTestHarness();
});

afterEach(() => {
  cleanup();
  harness.dispose();
});

function renderFilterLink(content: React.ReactNode) {
  return render(content, { wrapper: harness.wrapper });
}

describe("EntityFilterLink", () => {
  it("turns a read-only facet into a readable filtered-list link", () => {
    renderFilterLink(
      <EntityFilterLink
        to="/products"
        search={{ manufacturer: "Acme" }}
        label="Show all products by Acme"
        variant="value"
      >
        Acme
      </EntityFilterLink>,
    );

    const link = screen.getByRole("link", {
      name: "Show all products by Acme",
    });
    expect(link).toHaveAttribute("href", "/products?manufacturer=Acme");
    link.focus();
    expect(link).toHaveFocus();
  });

  it("keeps the filter action outside an editable value", () => {
    renderFilterLink(
      <BasicInfo
        fields={[
          {
            label: "Category",
            value: <button type="button">Edit category</button>,
            filterAction: (
              <EntityFilterLink
                to="/products"
                search={{ category: "CAT-2224" }}
                label="Show all products in Tools"
              />
            ),
          },
        ]}
      />,
    );

    const edit = screen.getByRole("button", { name: "Edit category" });
    const filter = screen.getByRole("link", {
      name: "Show all products in Tools",
    });
    expect(edit.contains(filter)).toBe(false);
    expect(filter).toHaveClass("size-10", "sm:size-7");
  });
});
