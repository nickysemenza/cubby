import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { defaultFilters } from "./dashboard-filter-state";
import { DashboardFilters } from "./dashboard-filters";

describe("DashboardFilters", () => {
  it("renders Done in the dialog's footer, not the scrollable body", () => {
    const harness = createBrowserTestHarness();
    try {
      render(
        <DashboardFilters
          filters={defaultFilters}
          onFiltersChange={() => {}}
          availableKinds={[]}
          availableLocations={[]}
          availableYears={[]}
          availableCompletionYears={[]}
          savedViews={null}
        />,
        { wrapper: harness.wrapper },
      );
      fireEvent.click(screen.getByRole("button", { name: "Filter projects" }));

      const done = screen.getByRole("button", { name: "Done" });
      // ResponsiveDialog's footer slot carries these classes on both its
      // desktop Dialog and mobile Sheet branches; the scrollable body does not.
      expect(done.closest(".border-t.bg-popover")).not.toBeNull();
    } finally {
      harness.dispose();
    }
  });
});
