import { useState } from "react";
import { EntityPreviewLink } from "~/app/_components/EntityPreviewLink";
import { Row } from "~/components/layout";
import { transformedImageUrl, transformedSrcSet } from "~/lib/image-url";
import { cn } from "~/lib/utils";
import { vendorMonogram } from "~/lib/vendor-logo";

/** Rendered edge in CSS px. `size-4` — an inline glyph, not a card icon. */
const MARK_PX = 16;

/**
 * The list/read-model supplies a displayable logo directly. We intentionally do
 * not infer an asset from a vendor name or shortcode: `Vendor.logoImageId` is
 * the only ownership relation and a missing logo is a first-class monogram.
 */
type VendorLogo = { url: string } | null | undefined;
const hasVendorLogo = (logo: VendorLogo): logo is { url: string } =>
  Boolean(logo?.url);

/**
 * A vendor's brand mark: its logo when we have one in R2, otherwise a monogram
 * tile. `Expense.vendor` is free text with a long tail of one-off local trades
 * and wedding vendors (42 of 82 vendors appear exactly once, and ~100 rows will
 * never have a logo), so the monogram is a first-class path, not an edge case.
 *
 * Desaturated at rest so a ledger full of logos stays as quiet as the rest of
 * the Warm-Paper palette, returning to full color on the hovered row — the color
 * arrives on the row you're actually reading. Touch has no hover to resolve it,
 * so below `sm` the mark is simply always in color.
 */
export function VendorMark({
  vendor,
  logo,
  className,
}: {
  vendor: string;
  /**
   * Rename-proof lookup key. Without a persisted id, the mark deliberately
   * stays a monogram instead of guessing that a same-slug asset exists.
   */
  vendorId?: string | null;
  /** Resolved through Vendor.logoImageId by the read model. */
  logo?: VendorLogo;
  className?: string;
}) {
  // The failure is remembered per URL rather than as a bare boolean: this node
  // is not remounted when a vendor is edited inline (same component instance,
  // new `vendor` prop), so a boolean set by the *previous* vendor's broken logo
  // would survive the swap and pin the new vendor to a monogram forever. Keying
  // the state to the URL it describes self-corrects on every change, with no
  // effect and no extra render pass.
  //
  const [failedUrl, setFailedUrl] = useState<string | null>(null);

  const shared = cn("size-4 shrink-0", className);

  // Null relations avoid a request entirely. A failed DB-resolved image URL
  // falls back to the same first-class monogram without guessing another key.
  if (!hasVendorLogo(logo) || failedUrl === logo.url) {
    return (
      <span
        aria-hidden
        className={cn(
          shared,
          "flex items-center justify-center border border-border bg-muted font-mono text-2xs text-slate leading-none",
        )}
      >
        {vendorMonogram(vendor)}
      </span>
    );
  }

  const url = logo.url;

  return (
    <span
      aria-hidden
      className={cn(
        shared,
        "flex items-center justify-center border border-border bg-muted p-px",
      )}
    >
      <img
        src={transformedImageUrl(url, MARK_PX)}
        srcSet={transformedSrcSet(url, MARK_PX)}
        alt=""
        loading="lazy"
        onError={() => setFailedUrl(url)}
        className="size-full object-contain grayscale transition-[filter] group-hover/row:grayscale-0 max-sm:grayscale-0"
      />
    </span>
  );
}

/**
 * The ledger's vendor cell: brand mark plus name.
 *
 * `compactOnMobile` is for the expenses table, whose mobile card renders this
 * same node into a width-constrained meta slot. There the logo alone carries the
 * vendor — but only when there *is* a logo; a bare monogram with no name would
 * make ~100 rows of local trades anonymous, so those drop the tile and keep the
 * name instead. Detail surfaces leave it off: there the vendor is a labeled
 * field whose value is the name.
 *
 * The compact case hides the name with `sr-only`, not `hidden`. The mark is a
 * decorative image with empty alternative text, so `hidden` would leave the cell with no accessible
 * name at all below `sm` — visually compact, silent to a screen reader. Keeping
 * the text in the a11y tree means the name has exactly one source at every
 * breakpoint, rather than moving into an `alt` that would double-announce on
 * desktop where the name is already visible.
 *
 * Supplying `vendorId` also makes the whole branded cell the canonical vendor
 * detail link, with the same at-rest dotted underline and hover preview as
 * `EntityInlineLink`. Without an id it intentionally stays plain: during an
 * optimistic vendor edit, the displayed name can change before the refetched
 * ExpenseOut carries the new vendor's shortcode.
 */
export function VendorCell({
  vendor,
  vendorId,
  logo,
  compactOnMobile,
}: {
  vendor: string;
  /** Forwarded to both `hasVendorLogo` and `VendorMark` — see `VendorMark`'s
   * doc. Passing it to only one would make `compactOnMobile`'s logo-presence
   * check disagree with what the mark actually renders. */
  vendorId?: string | null;
  /** Forwarded to VendorMark and used by compact mobile layout. */
  logo?: VendorLogo;
  compactOnMobile?: boolean;
}) {
  const hasLogo = hasVendorLogo(logo);
  const body = (
    <Row gap="sm" align="center" className="min-w-0">
      {(!compactOnMobile || hasLogo) && (
        <VendorMark
          vendor={vendor}
          vendorId={vendorId}
          logo={logo}
          className={
            vendorId ? "group-hover/vendor-link:grayscale-0" : undefined
          }
        />
      )}
      <span
        className={cn(
          "truncate",
          compactOnMobile && hasLogo && "max-sm:sr-only",
          vendorId &&
            "font-medium underline decoration-border/70 decoration-dotted underline-offset-2 group-hover/vendor-link:decoration-primary group-hover/vendor-link:decoration-solid",
        )}
      >
        {vendor}
      </span>
    </Row>
  );

  // An id-less value is either genuinely unresolved or the optimistic window
  // after choosing a new vendor, before the refetched ExpenseOut carries that
  // vendor's persisted shortcode. A guessed href would point at the old vendor,
  // so only a canonical id turns the branded cell into an entity link.
  if (!vendorId) return body;

  return (
    <EntityPreviewLink
      entity="vendor"
      id={vendorId}
      displayImage={logo?.url ? { url: logo.url } : null}
      showIdentityMark={false}
      className="group/vendor-link inline-flex min-w-0 max-w-full text-foreground transition-colors hover:text-primary"
    >
      {body}
    </EntityPreviewLink>
  );
}
