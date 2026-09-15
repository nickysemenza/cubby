import { testShortcode } from "@cubby/schemas/testing";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { ArrangeMoveTo, type ArrangeMoveTarget } from "./ArrangeMoveTo";

const target: ArrangeMoveTarget = {
  kind: "location",
  locationId: testShortcode("location", "LOC-4K7M"),
  name: "Test bed",
  roots: [],
};

let harness: ReturnType<typeof createBrowserTestHarness>;

beforeEach(() => {
  harness = createBrowserTestHarness();
});

afterEach(() => {
  harness.dispose();
});

describe("ArrangeMoveTo", () => {
  it("renders Cancel and Move in the dialog's footer, not the scrollable body", () => {
    render(<ArrangeMoveTo target={target} />, { wrapper: harness.wrapper });
    fireEvent.click(screen.getByRole("button", { name: "Move Test bed" }));

    const cancel = screen.getByRole("button", { name: "Cancel" });
    const move = screen.getByRole("button", { name: "Move" });
    // ResponsiveDialog's footer slot carries these classes on both its
    // desktop Dialog and mobile Sheet branches; the scrollable body does not.
    expect(cancel.closest(".border-t.bg-popover")).not.toBeNull();
    expect(move.closest(".border-t.bg-popover")).not.toBeNull();
  });
});
