import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { VENDOR_LOGO_BY_ID } from "~/lib/vendor-logos.generated";
import { VendorCell, VendorMark } from "./vendor-cell";

vi.mock("~/app/_components/EntityPreviewLink", () => ({
  EntityPreviewLink: ({
    children,
    id,
    className,
  }: {
    children: ReactNode;
    id: string;
    className?: string;
  }) => (
    <a href={`/vendors/${id}`} className={className}>
      {children}
    </a>
  ),
}));

// Driven off a live manifest entry, not a hardcoded id, so these survive a
// re-seed that drops or renumbers vendors — any entry works, this just needs
// one to exist.
const [SEEDED_ID] = Object.entries(VENDOR_LOGO_BY_ID)[0] ?? [];
if (!SEEDED_ID) {
  throw new Error(
    "VENDOR_LOGO_BY_ID is empty — vendor-cell.unit.test.tsx needs at least one seeded entry to test the vendorId-resolved path against.",
  );
}
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
    render(<VendorCell vendor={RENAMED_VENDOR} vendorId={SEEDED_ID} />);

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

/**
 * The `vendorId` prop's whole reason to exist: a vendor rename must not
 * demote its logo to a monogram just because the NAME-derived slug no longer
 * matches. These fail on `main`, where `VendorCell`/`VendorMark` have no
 * `vendorId` prop and can only ever slug the (possibly stale) name.
 */
describe("VendorCell / VendorMark with vendorId", () => {
  it("resolves the logo by id even when the name matches no slug (rename-doesn't-demote)", () => {
    render(<VendorMark vendor={RENAMED_VENDOR} vendorId={SEEDED_ID} />);
    expect(document.querySelector("img")).toBeTruthy();
  });

  it("keys the failed-logo guard on the RESOLVED slug, not a name-derived one", () => {
    const { rerender } = render(
      <VendorMark vendor={RENAMED_VENDOR} vendorId={SEEDED_ID} />,
    );
    expect(document.querySelector("img")).toBeTruthy();

    fireEvent.error(document.querySelector("img") as HTMLImageElement);
    expect(document.querySelector("img")).toBeNull();

    // Re-rendering with the SAME vendor/id must not retry the broken request.
    // If `failedSlug` were keyed on `vendorSlug(vendor)` (the name-derived
    // slug — which for a renamed vendor differs from the id-resolved slug
    // that actually failed above), this guard would never match its own
    // failure and the <img> would come back every render.
    rerender(<VendorMark vendor={RENAMED_VENDOR} vendorId={SEEDED_ID} />);
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
        compactOnMobile
      />,
    );
    expect(document.querySelector("img")).toBeTruthy();
    const name = screen.getByText(RENAMED_VENDOR);
    expect(name.className).toContain("max-sm:sr-only");
  });
});
