import { useState } from "react";
import { Row } from "~/components/layout";
import { transformedImageUrl, transformedSrcSet } from "~/lib/image-url";
import { cn } from "~/lib/utils";
import {
  VENDOR_LOGO_PREFIX,
  vendorMonogram,
  vendorSlug,
} from "~/lib/vendor-logo";
import { VENDOR_LOGO_SLUGS } from "~/lib/vendor-logos.generated";

/** Bucket host serving `vendors/<slug>.<ext>`; see scripts/seed-vendor-logos.ts. */
const BUCKET_ORIGIN = "https://foobucket.nicky.fun";

/** Rendered edge in CSS px. `size-4` — an inline glyph, not a card icon. */
const MARK_PX = 16;

/** Whether this vendor has a logo, so callers can lay out around its absence. */
const hasVendorLogo = (vendor: string): boolean =>
  VENDOR_LOGO_SLUGS.has(vendorSlug(vendor));

/**
 * A vendor's brand mark: its logo when we have one in R2, otherwise a monogram
 * tile. `Purchase.vendor` is free text with a long tail of one-off local trades
 * and wedding vendors (42 of 82 vendors appear exactly once, and ~100 rows will
 * never have a logo), so the monogram is a first-class path, not an edge case.
 *
 * Desaturated at rest so a ledger full of logos stays as quiet as the rest of
 * the Warm-Paper palette, returning to full color on the hovered row — the color
 * arrives on the row you're actually reading. Touch has no hover to resolve it,
 * so below `sm` the mark is simply always in color.
 */
function VendorMark({
  vendor,
  className,
}: {
  vendor: string;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const slug = vendorSlug(vendor);

  const shared = cn("size-4 shrink-0", className);

  // `failed` covers the offline PWA and a manifest that has drifted ahead of the
  // bucket; the manifest lookup is what keeps the common logo-less vendor from
  // costing a failed request in the first place.
  if (!VENDOR_LOGO_SLUGS.has(slug) || failed) {
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

  // Always PNG — the seed script normalizes every source format on the way in,
  // so Cloudflare Image Transformations can serve an exact 1x/2x AVIF/WebP pair
  // off whatever resolution the original happened to be.
  const url = `${BUCKET_ORIGIN}/${VENDOR_LOGO_PREFIX}/${slug}.png`;

  return (
    <img
      src={transformedImageUrl(url, MARK_PX)}
      srcSet={transformedSrcSet(url, MARK_PX)}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
      className={cn(
        shared,
        "object-contain grayscale transition-[filter] group-hover/row:grayscale-0 max-sm:grayscale-0",
      )}
    />
  );
}

/**
 * The ledger's vendor cell: brand mark plus name.
 *
 * `compactOnMobile` is for the purchases table, whose mobile card renders this
 * same node into a width-constrained meta slot. There the logo alone carries the
 * vendor — but only when there *is* a logo; a bare monogram with no name would
 * make ~100 rows of local trades anonymous, so those drop the tile and keep the
 * name instead. Detail surfaces leave it off: there the vendor is a labeled
 * field whose value is the name.
 */
export function VendorCell({
  vendor,
  compactOnMobile,
}: {
  vendor: string;
  compactOnMobile?: boolean;
}) {
  const logo = hasVendorLogo(vendor);
  return (
    <Row gap="sm" align="center" className="min-w-0">
      {(!compactOnMobile || logo) && <VendorMark vendor={vendor} />}
      <span
        className={cn("truncate", compactOnMobile && logo && "max-sm:hidden")}
      >
        {vendor}
      </span>
    </Row>
  );
}
