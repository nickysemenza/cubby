import { amount } from "@cubby/schemas/codec";
import { testShortcode } from "@cubby/schemas/testing";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { InventoryEntriesQuickEditDialog } from "./inventory-entries-quick-edit-dialog";

let harness: ReturnType<typeof createBrowserTestHarness>;

beforeEach(() => {
  harness = createBrowserTestHarness();
});

afterEach(() => {
  harness.dispose();
});

describe("InventoryEntriesQuickEditDialog", () => {
  it("renders a Done button in the dialog's footer, not the scrollable body", () => {
    render(
      <InventoryEntriesQuickEditDialog
        open
        onOpenChange={() => {}}
        productName="Test Widget"
        entries={[
          {
            id: testShortcode("inventory", "INV-4K7M"),
            amount: amount.parse({ value: 1, unit: "each" }),
            location: {
              id: testShortcode("location", "LOC-4K7M"),
              name: "Test bed",
              type: null,
            },
          },
        ]}
      />,
      { wrapper: harness.wrapper },
    );

    const done = screen.getByRole("button", { name: "Done" });
    // ResponsiveDialog's footer slot carries these classes on both its
    // desktop Dialog and mobile Sheet branches; the scrollable body does not.
    expect(done.closest(".border-t.bg-popover")).not.toBeNull();
  });
});
