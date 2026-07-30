import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { VendorCell } from "./vendor-cell";

/**
 * Both regressions here come from the same place: this cell is never remounted
 * when an expense's vendor is edited inline — `expenseVendorColumn` and the
 * detail page's Vendor field both just hand the same component instance a new
 * `vendor` prop.
 */
describe("VendorCell", () => {
  it("re-attempts the logo after a failure when the vendor changes", () => {
    const { rerender } = render(<VendorCell vendor="eBay" />);
    expect(screen.getByRole("presentation", { hidden: true })).toBeTruthy();

    // eBay's logo 404s (dead bucket entry, manifest drift, dropped connection).
    fireEvent.error(document.querySelector("img") as HTMLImageElement);
    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByText("EB")).toBeTruthy();

    // Correcting the vendor must not inherit the previous one's failure — a
    // bare `failed` boolean pinned every subsequent vendor to its monogram.
    rerender(<VendorCell vendor="Home Depot" />);
    expect(document.querySelector("img")).toBeTruthy();
    expect(screen.queryByText("HD")).toBeNull();
  });

  it("keeps the failure attached to the vendor that actually failed", () => {
    const { rerender } = render(<VendorCell vendor="eBay" />);
    fireEvent.error(document.querySelector("img") as HTMLImageElement);

    rerender(<VendorCell vendor="Home Depot" />);
    rerender(<VendorCell vendor="eBay" />);
    expect(screen.getByText("EB")).toBeTruthy();
  });

  it("keeps the vendor name reachable when the mark carries the cell", () => {
    // `compactOnMobile` hides the name below `sm`, where the only other element
    // is a decorative `alt=""` image. Hiding it with `display: none` would leave
    // the cell with no accessible name at all, so it must stay in the tree.
    render(<VendorCell vendor="eBay" compactOnMobile />);
    const name = screen.getByText("eBay");
    expect(name.className).toContain("sr-only");
    expect(name.className).not.toContain("max-sm:hidden");
  });
});
