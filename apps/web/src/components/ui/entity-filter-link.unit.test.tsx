import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    search,
    children,
    ...props
  }: {
    to: string;
    search?: Record<string, unknown>;
    children: ReactNode;
  }) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(search ?? {})) {
      if (value !== undefined)
        params.set(key, Array.isArray(value) ? value.join(",") : String(value));
    }
    const suffix = params.size > 0 ? `?${params}` : "";
    return (
      <a href={`${to}${suffix}`} {...props}>
        {children}
      </a>
    );
  },
}));

vi.mock("~/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ render }: { render: ReactNode }) => <>{render}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => (
    <span>{children}</span>
  ),
}));

import { BasicInfo } from "~/components/common/basic-info";
import { EntityFilterLink } from "./entity-filter-link";

describe("EntityFilterLink", () => {
  it("turns a read-only facet into a readable filtered-list link", () => {
    render(
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
    render(
      <BasicInfo
        fields={[
          {
            label: "Category",
            value: <button type="button">Edit category</button>,
            filterAction: (
              <EntityFilterLink
                to="/products"
                search={{ category: "tools" }}
                label="Show all products in tools"
              />
            ),
          },
        ]}
      />,
    );

    const edit = screen.getByRole("button", { name: "Edit category" });
    const filter = screen.getByRole("link", {
      name: "Show all products in tools",
    });
    expect(edit.contains(filter)).toBe(false);
    expect(filter).toHaveClass("size-10", "sm:size-7");
  });
});
