import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DialogFormActions } from "./dialog-form-actions";
import { ResponsiveDialog } from "./responsive-dialog";

/** Forces `useIsMobile()` to the phone branch, independent of jsdom's default width. */
function stubMobileViewport() {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: true,
      addEventListener: () => {},
      removeEventListener: () => {},
    })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ResponsiveDialog phone sheet + DialogFormActions seam", () => {
  it("promotes Cancel/Submit into the 52px header and renders no footer", () => {
    stubMobileViewport();
    render(
      <ResponsiveDialog
        open
        onOpenChange={() => {}}
        title="New garden entry"
        description="Add a garden entry."
        footer={
          <DialogFormActions
            onCancel={() => {}}
            submitLabel="Create"
            form="entry-form"
          />
        }
      >
        <form id="entry-form">fields</form>
      </ResponsiveDialog>,
    );

    // Exactly one Cancel and one Create control exist — in the header, not a
    // separate footer row.
    const cancelButtons = screen.getAllByRole("button", { name: "Cancel" });
    const submitButtons = screen.getAllByRole("button", { name: "Create" });
    expect(cancelButtons).toHaveLength(1);
    expect(submitButtons).toHaveLength(1);

    // The submit control still targets the real form by id, even though it
    // renders in the sheet header rather than beside the form.
    expect(submitButtons[0]).toHaveAttribute("form", "entry-form");

    // The title reads in the compact header; the description does not (no
    // room in a 52px Cancel/title/submit row).
    expect(screen.getByText("New garden entry")).toBeVisible();
    expect(screen.queryByText("Add a garden entry.")).not.toBeInTheDocument();

    // The footer region stays mounted (unmounting it would tear down
    // DialogFormActions's registration effect and loop), but is hidden —
    // DialogFormActions itself rendered nothing visible once it registered.
    const footerRegion = document.querySelector(
      '[data-slot="responsive-dialog-footer"]',
    );
    expect(footerRegion).toHaveClass("hidden");
    expect(footerRegion).toBeEmptyDOMElement();
  });

  it("keeps the ordinary footer row on desktop", () => {
    render(
      <ResponsiveDialog
        open
        onOpenChange={() => {}}
        title="New garden entry"
        footer={
          <DialogFormActions
            onCancel={() => {}}
            submitLabel="Create"
            form="entry-form"
          />
        }
      >
        <form id="entry-form">fields</form>
      </ResponsiveDialog>,
    );

    expect(
      screen.getByRole("button", { name: "Cancel" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Create" }),
    ).toBeVisible();
    // Desktop keeps the dedicated footer region.
    expect(
      document.querySelector('[data-slot="responsive-dialog-footer"]'),
    ).not.toBeNull();
  });
});
