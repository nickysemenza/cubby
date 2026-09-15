import { testShortcode } from "@cubby/schemas/testing";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { AddInventoryDialog } from "./add-inventory-dialog";

let harness: ReturnType<typeof createBrowserTestHarness>;

beforeEach(() => {
  harness = createBrowserTestHarness();
});

afterEach(() => {
  harness.dispose();
});

describe("AddInventoryDialog", () => {
  it("renders a Done button in the dialog's footer, not the scrollable body", () => {
    render(
      <AddInventoryDialog
        open
        onOpenChange={() => {}}
        locationId={testShortcode("location", "LOC-4K7M")}
        locationName="Test bed"
        onSuccess={() => {}}
      />,
      { wrapper: harness.wrapper },
    );

    const done = screen.getByRole("button", { name: "Done" });
    // ResponsiveDialog's footer slot carries these classes on both its
    // desktop Dialog and mobile Sheet branches; the scrollable body does not.
    expect(done.closest(".border-t.bg-popover")).not.toBeNull();
  });
});
