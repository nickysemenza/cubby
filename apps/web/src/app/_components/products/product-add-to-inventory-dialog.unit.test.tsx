import { testShortcode } from "@cubby/schemas/testing";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { ProductAddToInventoryDialog } from "./product-add-to-inventory-dialog";

const product = {
  id: testShortcode("product", "PRD-4K7M"),
  name: "Test Widget",
  manufacturer: "Acme",
};

let harness: ReturnType<typeof createBrowserTestHarness>;

beforeEach(() => {
  harness = createBrowserTestHarness();
});

afterEach(() => {
  harness.dispose();
});

describe("ProductAddToInventoryDialog", () => {
  it("renders a Done button in the dialog's footer, not the scrollable body", () => {
    render(
      <ProductAddToInventoryDialog
        open
        onOpenChange={() => {}}
        product={product}
      />,
      { wrapper: harness.wrapper },
    );

    const done = screen.getByRole("button", { name: "Done" });
    // ResponsiveDialog's footer slot carries these classes on both its
    // desktop Dialog and mobile Sheet branches; the scrollable body does not.
    expect(done.closest(".border-t.bg-popover")).not.toBeNull();
  });
});
