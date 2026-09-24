import { ArrowSquareOutIcon as ExternalLinkGlyph } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";

/**
 * Outbound links to somewhere that isn't Cubby — a vendor's order page, an
 * expense's receipt URL, a vendor website.
 *
 * Two shapes, both of which were hand-rolled at half a dozen call sites before
 * this file existed:
 *
 * - `ExternalLinkIcon` — an icon-only affordance that sits *beside* content
 *   which owns its own click (a table row, an inline editor's value, an entity
 *   name link). This is the shape to reach for inside a table.
 * - `ExternalLinkText` — the URL (or a label) rendered as the link itself, with
 *   a trailing glyph. For detail-page info rows where the URL is the content.
 *
 * Both stop click propagation, which is load-bearing rather than defensive:
 * without it, a click inside an `RTable` row navigates to the row's detail page
 * and a click inside an `EditableCell` opens the inline editor instead of
 * following the link.
 */

type ExternalLinkBaseProps = {
  href: string;
  className?: string;
};

/** Icon-only outbound link. `label` becomes the accessible name. */
export function ExternalLinkIcon({
  href,
  label,
  className,
}: ExternalLinkBaseProps & { label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      className={cn(
        "shrink-0 text-muted-foreground transition-colors hover:text-primary",
        className,
      )}
    >
      <ExternalLinkGlyph className="size-3.5" />
      <span className="sr-only">{label}</span>
    </a>
  );
}

/** Outbound link whose visible content is the link. Defaults to showing `href`. */
export function ExternalLinkText({
  href,
  children,
  truncate = false,
  className,
}: ExternalLinkBaseProps & { children?: ReactNode; truncate?: boolean }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      className={cn(
        "inline-flex items-center gap-1",
        truncate
          ? "truncate text-muted-foreground transition-colors hover:text-primary"
          : "hover:underline",
        className,
      )}
    >
      <span className={truncate ? "truncate" : undefined}>
        {children ?? href}
      </span>
      <ExternalLinkGlyph className="size-3 shrink-0 text-muted-foreground" />
    </a>
  );
}
