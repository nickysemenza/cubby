import {
  fireEvent,
  render as renderWithTestingLibrary,
  screen,
} from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { VendorCell, VendorMark } from "./vendor-cell";

let harness: ReturnType<typeof createBrowserTestHarness>;

beforeEach(() => {
  harness = createBrowserTestHarness();
});

afterEach(() => {
  harness.dispose();
});

function render(element: ReactElement) {
  return renderWithTestingLibrary(element, { wrapper: harness.wrapper });
}

function logoImage() {
  const image = document.querySelector("img");
  if (!image) throw new Error("Expected the resolved vendor logo image.");
  return image;
}

const SEEDED_ID = "VEN-ABCD";
const EBAY_LOGO = { url: "https://media.example.com/vendors/ebay.png" };
const HOME_DEPOT_LOGO = {
  url: "https://media.example.com/vendors/home-depot.png",
};
// Deliberately a name that slugs to nothing in the manifest, so any logo that
// renders for it can only have come from `vendorId` resolution, never from
// the name-derived fallback — that's what isolates the id-first behavior.
const RENAMED_VENDOR = "Totally Unrelated Renamed Co";

/**
 * Both regressions here come from the same place: this cell is never remounted
 * when an expense's vendor is edited inline — `expenseVendorColumn` and the
 * detail page's Vendor field both just hand the same component instance a new
 * `vendor` prop.
 */
describe("VendorCell", () => {
  it("links a persisted vendor with an at-rest affordance", () => {
    render(
      <VendorCell
        vendor={RENAMED_VENDOR}
        vendorId={SEEDED_ID}
        logo={EBAY_LOGO}
      />,
    );

    const link = screen.getByRole("link", { name: RENAMED_VENDOR });
    expect(link).toHaveAttribute("href", `/vendors/${SEEDED_ID}`);
    expect(screen.getByText(RENAMED_VENDOR)).toHaveClass("decoration-dotted");
    // Linking the cell must not trade away its rename-safe branded mark.
    expect(document.querySelector("img")).toBeTruthy();
  });

  it("stays unlinked until a persisted vendor id is available", () => {
    render(<VendorCell vendor="Optimistic New Vendor" />);

    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByText("Optimistic New Vendor")).not.toHaveClass(
      "decoration-dotted",
    );
  });

  it("does not guess a logo from a name without a manifest shortcode", () => {
    render(<VendorMark vendor="eBay" />);

    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByText("EB")).toBeTruthy();
  });

  it("re-attempts the logo after a failure when the vendor changes", () => {
    const { rerender } = render(
      <VendorCell vendor="eBay" vendorId={SEEDED_ID} logo={EBAY_LOGO} />,
    );
    expect(screen.getByRole("presentation", { hidden: true })).toBeTruthy();

    // eBay's logo 404s (dead bucket entry, manifest drift, dropped connection).
    fireEvent.error(logoImage());
    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByText("EB")).toBeTruthy();

    // Correcting the vendor must not inherit the previous one's failure — a
    // bare `failed` boolean pinned every subsequent vendor to its monogram.
    rerender(
      <VendorCell
        vendor="Home Depot"
        vendorId={SEEDED_ID}
        logo={HOME_DEPOT_LOGO}
      />,
    );
    expect(document.querySelector("img")).toBeTruthy();
    expect(screen.queryByText("HD")).toBeNull();
  });

  it("keeps the failure attached to the vendor that actually failed", () => {
    const { rerender } = render(
      <VendorCell vendor="eBay" vendorId={SEEDED_ID} logo={EBAY_LOGO} />,
    );
    fireEvent.error(logoImage());

    rerender(
      <VendorCell
        vendor="Home Depot"
        vendorId={SEEDED_ID}
        logo={HOME_DEPOT_LOGO}
      />,
    );
    rerender(
      <VendorCell vendor="eBay" vendorId={SEEDED_ID} logo={EBAY_LOGO} />,
    );
    expect(screen.getByText("EB")).toBeTruthy();
  });

  it("keeps the vendor name reachable when the mark carries the cell", () => {
    // `compactOnMobile` hides the name below `sm`, where the only other element
    // is a decorative image with empty alternative text. Hiding the name would leave
    // the cell with no accessible name at all, so it must stay in the tree.
    render(
      <VendorCell
        vendor="eBay"
        vendorId={SEEDED_ID}
        logo={EBAY_LOGO}
        compactOnMobile
      />,
    );
    const name = screen.getByText("eBay");
    expect(name.className).toContain("sr-only");
    expect(name.className).not.toContain("max-sm:hidden");
  });
});

/**
 * The `vendorId` prop's whole reason to exist: a vendor rename must not
 * demote its logo to a monogram just because the display name no longer matches
 * the stored asset slug.
 */
describe("VendorCell / VendorMark with a resolved logo", () => {
  it("puts every stored logo on the same neutral, ruled 16px plate", () => {
    const { container } = render(
      <VendorMark vendor="eBay" vendorId={SEEDED_ID} logo={EBAY_LOGO} />,
    );

    const plate = container.querySelector("span[aria-hidden='true']");
    const logo = container.querySelector("img");
    expect(plate).toHaveClass("size-4", "border", "border-border", "bg-muted");
    expect(logo).toHaveClass(
      "size-full",
      "object-contain",
      "grayscale",
      "group-hover/row:grayscale-0",
      "max-sm:grayscale-0",
    );
  });

  it("keeps the logo when a vendor is renamed", () => {
    render(
      <VendorMark
        vendor={RENAMED_VENDOR}
        vendorId={SEEDED_ID}
        logo={EBAY_LOGO}
      />,
    );
    expect(document.querySelector("img")).toBeTruthy();
  });

  it("keys the failed-logo guard on the RESOLVED slug, not a name-derived one", () => {
    const { rerender } = render(
      <VendorMark
        vendor={RENAMED_VENDOR}
        vendorId={SEEDED_ID}
        logo={EBAY_LOGO}
      />,
    );
    expect(document.querySelector("img")).toBeTruthy();

    fireEvent.error(logoImage());
    expect(document.querySelector("img")).toBeNull();

    // Re-rendering with the same vendor/id must not retry the broken request.
    rerender(
      <VendorMark
        vendor={RENAMED_VENDOR}
        vendorId={SEEDED_ID}
        logo={EBAY_LOGO}
      />,
    );
    expect(document.querySelector("img")).toBeNull();
  });

  it("keeps compactOnMobile consistent with the mark under an id-resolved logo", () => {
    // The name alone has no logo (`RENAMED_VENDOR` slugs to nothing), but the
    // id resolves one. `compactOnMobile`'s own presence check must agree with
    // what `VendorMark` actually renders — forwarding `vendorId` to only one
    // of the two would either hide the name behind a mark that isn't really
    // there, or show a bare unlabeled mark with no name, the "anonymous rows"
    // failure `VendorCell`'s doc comment warns about.
    render(
      <VendorCell
        vendor={RENAMED_VENDOR}
        vendorId={SEEDED_ID}
        logo={EBAY_LOGO}
        compactOnMobile
      />,
    );
    expect(document.querySelector("img")).toBeTruthy();
    const name = screen.getByText(RENAMED_VENDOR);
    expect(name.className).toContain("max-sm:sr-only");
  });
});
